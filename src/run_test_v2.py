"""launchd wrapper for the single v2 test run; exits at once if the results already exist."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OMP = next(Path(sys.prefix).glob("lib/python3.*/site-packages/sklearn/.dylibs"))
if os.environ.get("DYLD_LIBRARY_PATH") != str(OMP):
    os.execve(sys.executable, [sys.executable, *sys.argv], {**os.environ, "DYLD_LIBRARY_PATH": str(OMP)})
os.chdir(ROOT)

import backtest  # noqa: E402

if __name__ == "__main__":
    if not (ROOT / "data/results/test_v2_ci.json").exists():
        backtest.main_v2()
    print("all done", flush=True)
