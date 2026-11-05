"""Local round-3 stages with durable logs and atomic checkpoints. No publication.

Default: data, artifacts, checks, then browser checks and gallery, including Part 4 geometry.
--local-only skips browser launch; --browser-only resumes browser checks/gallery.
--orientation-only runs just the Part 4 browser checks against recorded weather.
Per-quarter downloads, per-quantile models and monthly predictions also checkpoint
inside their own stages. A failed stage never gets marked complete.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
STATE = ROOT / 'data/round3'
STATE.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, PYTHONPATH=str(ROOT / 'src'),
           DYLD_LIBRARY_PATH=str(ROOT / '.venv/lib/python3.11/site-packages/sklearn/.dylibs'),
           MPLCONFIGDIR=str(ROOT / '.cache/matplotlib'),
           PLAYWRIGHT_BROWSERS_PATH=str(ROOT / 'tools/browsers'),
           NODE_PATH=str(ROOT / 'tools/node_modules'))
PYTHON = str(ROOT / '.venv/bin/python')


def fingerprint(paths):
    digest = hashlib.sha256()
    for path in sorted(set(Path(p) for p in paths)):
        digest.update(str(path).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def stage(name, command, inputs=(), outputs=(), always=False):
    checkpoint = STATE / f'{name}.json'
    expected = fingerprint(inputs)
    if checkpoint.exists() and not always:
        saved = json.loads(checkpoint.read_text())
        if saved.get('inputs') == expected and all(Path(p).exists() for p in outputs):
            if saved.get('outputs') == fingerprint(outputs):
                print(f'RESUME {name}', flush=True)
                return
    print(f'RUN {name} (log: data/round3/{name}.log)', flush=True)
    with (STATE / f'{name}.log').open('w') as log:
        result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        print((STATE / f'{name}.log').read_text()[-3500:], flush=True)
        raise SystemExit(f'{name} failed. Completed stages remain saved. Rerun the same command after resolving it.')
    if not all(Path(p).exists() for p in outputs):
        raise SystemExit(f'{name}: expected output missing; no checkpoint written')
    saved = dict(inputs=expected, outputs=fingerprint(outputs),
                 finished=datetime.now(timezone.utc).isoformat(), command=command)
    tmp = checkpoint.with_suffix('.tmp')
    tmp.write_text(json.dumps(saved, indent=2) + '\n')
    tmp.replace(checkpoint)
    print(f'PASS {name}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--local-only', action='store_true')
    group.add_argument('--browser-only', action='store_true')
    group.add_argument('--orientation-only', action='store_true')
    args = parser.parse_args()
    if args.orientation_only:
        stage('browser-orientation', ['node', 'tools/check-orientation.mjs'], always=True)
        return
    if not args.browser_only:
        for day in (3, 4):
            # Always check the requested through-date; the downloader skips complete quarters.
            stage(f'weather-h{day}', [PYTHON, 'src/download_weather.py', str(day)], always=True)
        source = ['src/horizons.py', 'src/features.py', 'src/backtest.py']
        outputs = ['data/results/horizons.csv', 'data/results/horizons_elia.csv',
                   'data/horizons/counts.json', 'site/img/horizons.png']
        stage('horizons', [PYTHON, 'src/horizons.py'], inputs=source, outputs=outputs)
        stage('evidence', [PYTHON, 'src/horizon_evidence.py'],
              inputs=['src/horizon_evidence.py', *outputs[:3]],
              outputs=['site/data/horizons.json'])
        stage('exports', [PYTHON, 'src/export_site.py', 'horizons', '2026-11'],
              inputs=['src/export_site.py', *source, 'site/model/weather.json'],
              outputs=[f'site/model/weather_h{h}.json' for h in (1, 2, 3)] +
                      [f'site/test/fixtures/{p}_h{h}.json' for p in ('cambridge', 'brussels', 'lisbon') for h in (2, 3)] +
                      ['site/data/shifts.json'])
        stage('python-tests', [PYTHON, '-m', 'unittest', 'src/test_horizons.py', '-q'], always=True)
        stage('deck-build', ['node', 'deck/build.js'],
              inputs=['deck/build.js', 'deck/content.js', 'deck/html.js', 'site/data/horizons.json', 'tools/package-lock.json'],
              outputs=['site/deck.html', 'site/Penumbra_DATANOVA_2026.pptx'])
        # Discover only the documented, non-Library skill root; allow a portable override.
        skill = Path(os.environ.get('PPTX_SKILL', str(Path.home() / '.agents/skills/synced/88689e78-34e0-4592-9f5d-2c58ad7ffb01_3c66681b-23fe-42e1-bf10-c7e3c1069241/pptx')))
        validator = skill / 'scripts/office/validate.py'
        if validator.exists():
            stage('pptx-validation', [PYTHON, str(validator), 'site/Penumbra_DATANOVA_2026.pptx'], always=True)
        stage('node-tests', ['node', '--test', *map(str, sorted(Path('site/test').glob('*.test.mjs')))], always=True)
    if not args.local_only:
        stage('browser-horizons', ['node', 'tools/check-horizons.mjs'], always=True)
        stage('browser-deck', ['node', 'tools/check-deck.mjs'], always=True)
        stage('gallery', ['node', 'tools/gallery.mjs'], always=True,
              outputs=[f'docs/gallery/{name}.png' for name in ('01-cambridge-forecast', '02-horizon-choice', '03-ledger', '04-evidence', '05-deck')])
        stage('browser-orientation', ['node', 'tools/check-orientation.mjs'], always=True)
        print('Parts 1–4 browser checks passed.', flush=True)


if __name__ == '__main__':
    main()
