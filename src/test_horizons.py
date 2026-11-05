"""Causality and downloader regression tests for the fixed horizon specification."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

import numpy as np
import pandas as pd

from backtest import FROZEN, WEATHER, conformalize, fit_predict
from download_weather import fetch, main, MODELS, VARS
from features import add_lags, weather_features


class HorizonTests(unittest.TestCase):
    def test_weather_spec_has_no_outcome_lags(self):
        self.assertEqual(FROZEN['weather']['feats'], WEATHER)
        self.assertFalse({'cf_d2', 'perf7'} & set(WEATHER))

    def test_shifted_lags_stop_before_issue_day(self):
        times = pd.date_range('2025-01-01', periods=96 * 20, freq='15min', tz='UTC')
        table = pd.DataFrame(dict(datetime=times, cf=np.repeat(np.arange(20.), 96), clear_sky=100., tso_p50=1.))
        for h in (1, 2, 3):
            out = add_lags(table, horizon=h)
            self.assertEqual(out.iloc[-1].cf_d2, 19 - h - 1)
            # Changes from the issue day onward cannot affect target-day full-day lags.
            changed = table.copy()
            changed.loc[changed.datetime >= times[-1].floor('D') - pd.Timedelta(days=h), 'cf'] = 999
            fresh = add_lags(changed, horizon=h)
            for key in ['cf_d2', 'perf7', 'tso_err7', 'tso_abs7']:
                self.assertAlmostEqual(out.iloc[-1][key], fresh.iloc[-1][key])

    def test_previous_run_columns_are_selected(self):
        times = pd.date_range('2025-06-01', periods=48, freq='h', tz='UTC')
        for day in (2, 3, 4):
            raw = pd.DataFrame({'time': times})
            for v in VARS:
                for m in MODELS:
                    raw[f'{v}_previous_day{day}_{m}'] = 100.
            result = weather_features(raw, 50., 4., previous_day=day)
            if day == 2:
                reference = result
            else:
                pd.testing.assert_frame_equal(reference, result)

    def test_refit_excludes_horizon_gap(self):
        dates = pd.date_range('2025-01-01', '2025-02-02', tz='UTC')
        table = pd.DataFrame({'datetime': dates, 'date': dates, 'cf': .1, 'region': 'Belgium', 'elevation': 20.,
                              'tso_p10': .1, 'tso_p50': .2, 'tso_p90': .3, 'cf_d2': .1, 'x': np.arange(len(dates))})
        for h in (1, 2, 3):
            estimator = Mock()
            estimator.predict.side_effect = lambda x, **kwargs: np.full(len(x), .1)
            with patch('backtest.lgb.LGBMRegressor', return_value=estimator):
                fit_predict(table, ['x'], '2025-02-01', '2025-02-01', gap_days=h + 1)
            used = estimator.fit.call_args.args[0].index
            self.assertTrue((table.loc[used, 'datetime'] < pd.Timestamp('2025-02-01', tz='UTC') - pd.Timedelta(days=h + 1)).all())
            self.assertEqual(len(used), 31 - h - 1)

    def test_calibration_ignores_outcomes_after_cutoff(self):
        dates = pd.date_range('2025-01-01', periods=90, tz='UTC')
        frame = pd.DataFrame({'datetime': dates, 'date': dates, 'cf': .2, 'region': 'Belgium', 'elevation': 30., 'p10': .1, 'p50': .2, 'p90': .3})
        for h in (1, 2, 3):
            changed = frame.copy()
            changed.loc[changed.date >= dates[-1] - pd.Timedelta(days=h + 1), 'cf'] = 100.
            a = conformalize(frame.copy(), scoped=True, gap_days=h + 1)
            b = conformalize(changed, scoped=True, gap_days=h + 1)
            self.assertEqual(a.iloc[-1].p10c, b.iloc[-1].p10c)
            self.assertEqual(a.iloc[-1].p90c, b.iloc[-1].p90c)

    def test_download_uses_offsets_backoff_atomic_write_and_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'Brussels_20240101.parquet'
            response = Mock(status_code=200)
            response.json.return_value = {'hourly': {'time': ['2024-01-01T00:00', '2024-03-31T23:00'], 'temperature_2m_previous_day4': [10., 10.]}}
            with patch('download_weather.requests.get', side_effect=[Mock(status_code=429), response]) as get, patch('download_weather.time.sleep') as sleep:
                fetch('Brussels', 50.85, 4.37, '2024-01-01', '2024-03-31', out, previous_days=(4,))
                sleep.assert_called_once_with(70)
                self.assertIn('shortwave_radiation_previous_day4', get.call_args.kwargs['params']['hourly'])
                self.assertNotIn('previous_day2', get.call_args.kwargs['params']['hourly'])
            self.assertTrue(out.exists())
            self.assertFalse(out.with_suffix('.tmp').exists())
            with patch('download_weather.fetch') as download:
                main({'Brussels': (50.85, 4.37)}, end='2024-03-31', folder=directory, previous_days=(4,))
                download.assert_not_called()

    def test_resume_refreshes_an_incomplete_current_quarter(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'Brussels_20240101.parquet'
            pd.DataFrame({'time': pd.to_datetime(['2024-01-01'], utc=True)}).to_parquet(out)
            with patch('download_weather.fetch') as download, patch('download_weather.time.sleep'):
                main({'Brussels': (50.85, 4.37)}, end='2024-01-02', folder=directory, previous_days=(4,))
                download.assert_called_once()


if __name__ == '__main__':
    unittest.main()
