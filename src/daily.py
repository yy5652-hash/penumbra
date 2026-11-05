"""Daily ledger job for launchd: issue the next forecast, rescore, refresh the site's data, commit the ledger.

launchd may not run shell scripts inside ~/Documents, so the job is this Python file run by the project's interpreter.
Safe to run many times a day and after every boot.
"""
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OMP = next(Path(sys.prefix).glob("lib/python3.*/site-packages/sklearn/.dylibs"))
# launchd refuses DYLD_ variables in a job, so set the OpenMP path here and start again.
if os.environ.get("DYLD_LIBRARY_PATH") != str(OMP):
    os.execve(sys.executable, [sys.executable, *sys.argv], {**os.environ, "DYLD_LIBRARY_PATH": str(OMP)})

import export_site  # noqa: E402
import requests  # noqa: E402
import live  # noqa: E402


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


def main():
    print(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "start", flush=True)
    # Right after a boot the network may not be up yet: retry for about ten minutes before giving up.
    for attempt in range(5):
        try:
            live.run()
            break
        except requests.ConnectionError as exc:
            print("network not ready:", str(exc)[:120], flush=True)
            if attempt == 4:
                raise
            time.sleep(120)
    export_site.main(["daily"])
    git("add", "ledger", "site/ledger", "site/data/shifts.json")
    if git("diff", "--cached", "--quiet").returncode:
        git("commit", "-qm", f"Ledger update {datetime.now(timezone.utc):%Y-%m-%dT%H:%MZ}")
    # Publishing stays off until the owner has approved the public repository.
    if (ROOT / ".publish_enabled").exists():
        print(git("push", "-q", "origin", "HEAD").stderr, flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    sys.exit(main())
