"""Run the round-2 validation variants one after another under launchd; finished variants are cached, so a reboot only
repeats the one in progress. Writes every scoped=True block to data/results/round2.txt."""
import contextlib
import io
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OMP = next(Path(sys.prefix).glob("lib/python3.*/site-packages/sklearn/.dylibs"))
if os.environ.get("DYLD_LIBRARY_PATH") != str(OMP):
    os.execve(sys.executable, [sys.executable, *sys.argv], {**os.environ, "DYLD_LIBRARY_PATH": str(OMP)})
os.chdir(ROOT)

import experiments  # noqa: E402

NAMES = sys.argv[1:] or ["res_ec", "res_ext", "res_ext_ec"]

if __name__ == "__main__":
    out = ROOT / "data/results/round2.txt"
    for name in NAMES:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            experiments.main([name])
        text = buf.getvalue()
        block = text[text.find(f"== {name} scoped=True"):]
        with open(out, "a") as f:
            f.write(block + "\n")
        print(name, "done", flush=True)
    print("all done", " ".join(NAMES), flush=True)
