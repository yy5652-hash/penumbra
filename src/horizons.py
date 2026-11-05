"""Fixed-spec D+1..D+3 weather experiment. Never selects parameters on scores.

Run with PYTHONPATH=src and the documented DYLD_LIBRARY_PATH. Downloads must finish
first. Models and monthly caches stay outside the protected data/models directory.
LightGBM 4.7.0 quantile API: https://lightgbm.readthedocs.io/en/latest/Python-API.html
Previous Runs offsets: https://open-meteo.com/en/docs/previous-runs-api
"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from backtest import FIRST_OOS, FROZEN, QUANTILES, conformalize, fit_predict, score
from download_weather import PLACES
from features import add_lags, load_weather, weather_features

ROOT = Path('data/horizons')
START, END = '2025-05-01', '2026-10-31'
_WORKER_TABLE = None


def _load_worker(table_path):
    global _WORKER_TABLE
    _WORKER_TABLE = pd.read_parquet(table_path)


def _predict_month(job):
    horizon, month, cache = job
    path = cache / f'{month:%Y-%m}.parquet'
    if not path.exists():
        pred = fit_predict(_WORKER_TABLE, start=f'{month:%Y-%m-%d}', end=f'{month:%Y-%m-%d}',
                           gap_days=horizon + 1, model_dir=cache / 'models', **FROZEN['weather'])
        tmp = path.with_suffix('.tmp')
        pred.to_parquet(tmp)
        tmp.rename(path)
    return path


def build_table(horizon):
    """Same feature construction for every horizon, including capacity-weighted Belgium."""
    if horizon not in (1, 2, 3):
        raise ValueError('horizon must be 1, 2 or 3')
    if horizon == 1:
        weather = load_weather(live=True)
    else:
        folder = Path(f'data/weather_h{horizon + 1}')
        expected = [folder / f'{name}_{d:%Y%m%d}.parquet' for name in PLACES
                    for d in pd.date_range('2024-01-01', END, freq='QS')]
        missing = [str(p) for p in expected if not p.exists()]
        if missing:
            raise RuntimeError(f'Incomplete archive: {len(missing)} files missing; first {missing[0]}')
        weather = pd.concat([pd.read_parquet(p) for p in expected], ignore_index=True)
    elia = pd.read_parquet('data/raw/elia_ods032.parquet')
    live = pd.read_parquet('data/raw/elia_live.parquet')
    for frame in (elia, live):
        frame['datetime'] = pd.to_datetime(frame.datetime, utc=True).astype('datetime64[ns, UTC]')
    elia = pd.concat([elia[elia.datetime < live.datetime.min()], live], ignore_index=True)
    elia = elia[elia.region.isin([*PLACES, 'Belgium'])].drop_duplicates(['region', 'datetime'])
    # Match features.py: one fixed fleet-capacity weight per province.
    caps = elia[elia.region.isin(PLACES)].groupby('region').monitoredcapacity.last()
    weights = caps / caps.sum()
    parts = {n: weather_features(weather[weather.region == n], *ll, previous_day=horizon + 1)
             for n, ll in PLACES.items()}
    parts['Belgium'] = sum(parts[n].mul(weights[n]) for n in PLACES)
    tables = []
    for name, feats in parts.items():
        e = elia[elia.region == name].set_index('datetime')
        t = feats.join(e, how='inner').reset_index(names='datetime')
        t['cf'] = t.measured / t.monitoredcapacity
        for src, dst in [('dayahead11hforecast', 'tso_p50'), ('dayahead11hconfidence10', 'tso_p10'),
                         ('dayahead11hconfidence90', 'tso_p90')]:
            t[dst] = t[src] / t.monitoredcapacity
        tables.append(add_lags(t, horizon=horizon).assign(region=name))
    table = pd.concat(tables, ignore_index=True)
    table = table[(table.elevation > 0) & table.k_mean.notna() & table.cf.notna()]
    table['date'] = table.datetime.dt.floor('D')
    # Preserve features.py's province order for the fixed sampling seed.
    return table.reset_index(drop=True)


def run_horizon(horizon, workers=2):
    ROOT.mkdir(parents=True, exist_ok=True)
    completed = ROOT / f'pred_h{horizon}.parquet'
    if completed.exists():
        print(f'D+{horizon}: resuming completed predictions', flush=True)
        return pd.read_parquet(completed)
    table_path = ROOT / f'table_h{horizon}.parquet'
    if table_path.exists():
        table = pd.read_parquet(table_path)
    else:
        table = build_table(horizon)
        tmp = table_path.with_suffix('.tmp')
        table.to_parquet(tmp)
        tmp.replace(table_path)
    print(f'D+{horizon}: feature table ready, {len(table):,} rows', flush=True)
    table = table[table.datetime < pd.Timestamp(END, tz='UTC') + pd.Timedelta(days=1)]
    if horizon == 1:
        # Reuse the already recorded fixed-spec experiment. Only newly available
        # outcomes need predictions; use the saved frozen model for their month.
        old = pd.concat([pd.read_parquet(f'data/results/{stage}_weather.parquet')
                         for stage in ('val', 'test')], ignore_index=True)
        keys = ['datetime', 'region']
        old['datetime'] = old.datetime.astype('datetime64[ns, UTC]')
        old['date'] = old.date.astype('datetime64[ns, UTC]')
        extra = table.merge(old[keys].assign(recorded=True), on=keys, how='left')
        extra = extra[extra.recorded.isna()].drop(columns='recorded')
        extra = extra[extra.datetime >= pd.Timestamp(START, tz='UTC')]
        parts = []
        for month, part in extra.groupby(extra.datetime.dt.strftime('%Y-%m')):
            print('D+1: filling newly available rows', month, len(part), flush=True)
            boosters = site_boosters(1, month)
            arr = np.sort(np.clip(np.column_stack([b.predict(part[FROZEN['weather']['feats']], num_threads=6)
                                                   for b in boosters]), 0, None), axis=1)
            parts.append(part.assign(p10=arr[:, 0], p50=arr[:, 1], p90=arr[:, 2]))
        if parts:
            extra = pd.concat(parts, ignore_index=True)
            print('D+1: calibrating newly available rows', len(extra), flush=True)
            pool = conformalize(pd.concat([old, extra], ignore_index=True), scoped=True)
            extra = pool.merge(extra[keys], on=keys, validate='one_to_one')
            old = pd.concat([old, extra], ignore_index=True)
        old = old.sort_values(keys).reset_index(drop=True)
        tmp = completed.with_suffix('.tmp')
        old.to_parquet(tmp)
        tmp.replace(completed)
        (ROOT / 'h1_source.json').write_text(json.dumps(dict(
            recorded=['data/results/val_weather.parquet', 'data/results/test_weather.parquet'],
            added_rows=sum(len(p) for p in parts), new_rows_model='data/models/<target month>/weather_*.txt'), indent=2))
        print('D+1 reused recorded fixed-spec predictions; added rows', sum(len(p) for p in parts), flush=True)
        return old
    cache = ROOT / f'h{horizon}'
    cache.mkdir(exist_ok=True)
    jobs = [(horizon, month, cache) for month in pd.date_range(FIRST_OOS, END, freq='MS')]
    # Months are independent. Bound local concurrency; each model keeps FROZEN's
    # exact learning parameters and sampling seed. No score affects scheduling.
    with ProcessPoolExecutor(max_workers=workers, initializer=_load_worker,
                             initargs=(ROOT / f'table_h{horizon}.parquet',)) as pool:
        paths = list(pool.map(_predict_month, jobs))
    frames = [pd.read_parquet(path) for path in paths]
    pred = conformalize(pd.concat(frames, ignore_index=True), scoped=True, gap_days=horizon + 1)
    pred = pred[pred.datetime >= pd.Timestamp(START, tz='UTC')]
    tmp = completed.with_suffix('.tmp')
    pred.to_parquet(tmp)
    tmp.replace(completed)
    return pred


def latest_shifts(horizon, issue):
    """Only outcomes ending before issue day; keep an extra full-day safety gap."""
    pred = pd.read_parquet(ROOT / f'pred_h{horizon}.parquet')
    hi = issue.floor('D') - pd.Timedelta(days=1)
    pool = pred[(pred.region != 'Belgium') & (pred.date < hi)]
    last = pool.date.max()
    cal = pool[pool.date > last - pd.Timedelta(days=60)]
    bins = (cal.elevation > 15).astype(int) * 3 + np.digitize(cal.p90 - cal.p10, [.05, .15])
    lo = (cal.p10 - cal.cf).groupby(bins).quantile(.9)
    high = (cal.cf - cal.p90).groupby(bins).quantile(.9)
    return dict(through=f'{cal.date.max():%Y-%m-%d}', days=60,
                lo=[round(float(lo.get(i, 0)), 5) for i in range(6)],
                hi=[round(float(high.get(i, 0)), 5) for i in range(6)])


def site_boosters(horizon, month):
    """h1 uses the current frozen site model; h2/h3 never write data/models/."""
    if horizon == 1:
        root = Path('data/models') / month
        return [lgb.Booster(model_file=str(root / f'weather_{int(q * 100)}.txt')) for q in QUANTILES]
    root = ROOT / 'models' / month
    root.mkdir(parents=True, exist_ok=True)
    table = pd.read_parquet(ROOT / f'table_h{horizon}.parquet')
    cutoff = pd.Timestamp(month + '-01', tz='UTC') - pd.Timedelta(days=horizon + 1)
    tr = table[table.datetime < cutoff]
    out = []
    for q in QUANTILES:
        path = root / f'weather_h{horizon}_{int(q * 100)}.txt'
        if path.exists():
            b = lgb.Booster(model_file=str(path))
        else:
            m = lgb.LGBMRegressor(objective='quantile', alpha=q, **FROZEN['weather']['params'])
            m.fit(tr[FROZEN['weather']['feats']], tr.cf)
            b = m.booster_
            tmp = path.with_suffix('.tmp')
            b.save_model(str(tmp))
            tmp.replace(path)
        out.append(b)
    return out


def markdown_table(results):
    lines = ['| Horizon | Scope | Pinball | MAE | Cover 80 | Width |', '|---|---|---|---|---|---|']
    for r in results.itertuples():
        lines.append(f'| D+{r.horizon} | {r.scope} | {r.pinball:.6f} | {r.MAE:.2%} | {r.cover80:.2%} | {r.width:.2%} |')
    return '\n'.join(lines)


def summarize(frames):
    # All horizons are scored on the same daylight rows. Missing Elia forecasts
    # do not remove valid weather-only outcomes; the reference uses its available rows.
    keys = ['datetime', 'region']
    common = frames[1][keys]
    for h in (2, 3):
        common = common.merge(frames[h][keys], on=keys, validate='one_to_one')
    if common.empty:
        raise RuntimeError('No common daylight rows across horizons')
    outcomes = frames[1][keys + ['cf']].merge(common, on=keys, validate='one_to_one')
    rows, counts = [], {}
    for h, frame in frames.items():
        frame = frame.merge(common, on=keys, validate='one_to_one')
        check = frame[keys + ['cf']].merge(outcomes, on=keys, suffixes=('_h', '_h1'), validate='one_to_one')
        if not np.allclose(check.cf_h, check.cf_h1, atol=1e-12, rtol=0):
            raise RuntimeError(f'Outcome mismatch for D+{h}')
        counts[h] = dict(rows=len(frame), days=int(frame.date.nunique()))
        for scope, part in [('Belgium', frame[frame.region == 'Belgium']), ('Provinces', frame[frame.region != 'Belgium'])]:
            s = score(part, 'p10c', 'p50', 'p90c')
            rows.append(dict(horizon=h, scope=scope, pinball=s['pinball'], MAE=s['mae'], cover80=s['cover80'], width=s['width']))
    res = pd.DataFrame(rows)
    Path('data/results').mkdir(exist_ok=True)
    res.to_csv('data/results/horizons.csv', index=False)
    refs = []
    base = frames[1].merge(common, on=keys, validate='one_to_one').dropna(subset=['tso_p10', 'tso_p50', 'tso_p90'])
    for scope, part in [('Belgium', base[base.region == 'Belgium']), ('Provinces', base[base.region != 'Belgium'])]:
        refs.append(dict(scope=scope, rows=len(part), **score(part, 'tso_p10', 'tso_p50', 'tso_p90')))
    ref = pd.DataFrame(refs)
    ref.to_csv('data/results/horizons_elia.csv', index=False)
    (ROOT / 'counts.json').write_text(json.dumps(counts, indent=2))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(10, 4), layout='constrained')
    for scope, color in [('Belgium', '#22654f'), ('Provinces', '#c9812b')]:
        r = res[res.scope == scope]
        for ax, metric, factor, label in zip(axes, ['pinball', 'width'], [1, 100], ['Mean pinball loss', '80% band width (% of capacity)']):
            ax.plot(r.horizon, r[metric] * factor, 'o-', color=color, label=scope)
            v = ref.loc[ref.scope == scope, metric].iloc[0] * factor
            ax.plot([.88, 1.12], [v, v], '--', color=color, label=f'Elia {scope}, D+1 only')
            ax.set(xticks=[1, 2, 3], xticklabels=['D+1', 'D+2', 'D+3'], ylabel=label)
            ax.spines[['top', 'right']].set_visible(False)
            ax.grid(axis='y', alpha=.2)
    axes[0].legend(fontsize=8)
    fig.suptitle('Weather-only forecasts · 2025-05-01 to 2026-10-31')
    Path('site/img').mkdir(exist_ok=True)
    fig.savefig('site/img/horizons.png', dpi=180)
    plt.close(fig)
    print(markdown_table(res), flush=True)
    return res


def main():
    frames = {h: run_horizon(h) for h in (1, 2, 3)}
    summarize(frames)


if __name__ == '__main__':
    if sys.argv[1:]:
        run_horizon(int(sys.argv[1]))
    else:
        main()
