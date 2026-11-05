"""Generate the horizon evidence everywhere from the recorded CSV, without publishing."""
import json
from pathlib import Path

import pandas as pd

from horizons import markdown_table, ROOT, START, END

BEGIN, FINISH = '<!-- horizons:start -->', '<!-- horizons:end -->'


def write():
    res = pd.read_csv('data/results/horizons.csv')
    ref = pd.read_csv('data/results/horizons_elia.csv')
    counts = json.loads((ROOT / 'counts.json').read_text())
    table = markdown_table(res)
    note = (f'Weather-only models. Fixed features and parameters for all horizons. {START} to {END}. '
            f"Common daylight rows: {counts['1']['rows']:,} across {counts['1']['days']} days. "
            'Monthly refits and rolling scoped calibration use a gap of 2, 3 or 4 days. '
            'Full-day lags end before the issue day; the frozen weather specification uses no output lags. '
            'Elia is a D+1 reference only. Its score uses rows with a published day-ahead forecast.')
    md = f'{BEGIN}\n## Horizons\n\n{note}\n\n{table}\n\n![Weather-only accuracy and band width by horizon](site/img/horizons.png)\n{FINISH}'
    for name in ['EXPERIMENTS.md', 'README.md', 'docs/devpost.md']:
        path = Path(name)
        s = path.read_text()
        content = md.replace('(site/img/', '(../site/img/') if name.startswith('docs/') else md
        if BEGIN in s:
            a, b = s.index(BEGIN), s.index(FINISH) + len(FINISH)
            s = s[:a] + content + s[b:]
        else:
            s += '\n' + content + '\n'
        path.write_text(s)
    headers = ['Horizon', 'Scope', 'Pinball', 'MAE', 'Cover 80', 'Width']
    rows = [[f'D+{r.horizon}', r.scope, f'{r.pinball:.6f}', f'{r.MAE:.2%}', f'{r.cover80:.2%}', f'{r.width:.2%}'] for r in res.itertuples()]
    evidence = dict(headers=headers, rows=rows, note=note, results=res.to_dict('records'), elia=ref.to_dict('records'))
    Path('site/data/horizons.json').write_text(json.dumps(evidence, indent=2))
    html = '<section id="horizons"><h2>Horizons</h2><p>' + note + '</p><div class="table-scroll"><table><thead><tr>'
    html += ''.join(f'<th scope="col">{h}</th>' for h in headers) + '</tr></thead><tbody>'
    html += ''.join('<tr>' + ''.join(f'<td>{v}</td>' for v in row) + '</tr>' for row in rows)
    html += '</tbody></table></div><img src="img/horizons.png" alt="Weather-only pinball loss and band width for D+1, D+2 and D+3. Elia is a D+1 reference only." style="width:100%;height:auto"></section>'
    path = Path('site/how.html')
    s = path.read_text()
    block = BEGIN + html + FINISH
    if BEGIN in s:
        a, b = s.index(BEGIN), s.index(FINISH) + len(FINISH)
        s = s[:a] + block + s[b:]
    else:
        s = s.replace('<h2>What the ledger records</h2>', block + '<h2>What the ledger records</h2>')
    s = s.replace('with <code>_previous_day2</code>. Inputs are 48-hour-old predictions, aligned in UTC.',
                  'with <code>_previous_day2</code>, <code>_previous_day3</code> or <code>_previous_day4</code> for D+1, D+2 or D+3. Inputs are aligned in UTC. Each horizon has its own model and calibration. Models load when selected.')
    path.write_text(s)
    print(table)


if __name__ == '__main__':
    write()
