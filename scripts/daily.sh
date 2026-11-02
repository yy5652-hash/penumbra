#!/bin/bash
# Issue the next forecast, rescore, refresh the site's data, and commit only the ledger. Safe to run many times a day.
cd "$(dirname "$0")/.." || exit 1
export PYTHONPATH=src
export DYLD_LIBRARY_PATH="$PWD/.venv/lib/python3.11/site-packages/sklearn/.dylibs"
{
  date -u
  .venv/bin/python src/live.py run 2>&1 | grep -vE 'Pandas4Warning|dayofyear' | tail -6
  .venv/bin/python src/export_site.py daily 2>&1 | tail -1
  git add ledger site/ledger site/data/shifts.json
  git diff --cached --quiet || git commit -qm "Ledger update $(date -u +%Y-%m-%dT%H:%MZ)"
  # Publishing is off until the owner has approved the public repository.
  [ -f .publish_enabled ] && git push -q origin HEAD
} >> data/daily.log 2>&1
