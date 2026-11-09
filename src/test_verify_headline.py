"""Public evidence must verify in a checkout without private data or LightGBM."""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from verify_headline import check_references
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent


def test_verifier_in_clean_checkout(tmp_path):
    shutil.copytree(ROOT / "evidence", tmp_path / "evidence")
    source = tmp_path / "src"
    source.mkdir()
    shutil.copyfile(ROOT / "src/verify_headline.py", source / "verify_headline.py")
    # An accidental backtest/LightGBM import must fail even when installed locally.
    (source / "lightgbm.py").write_text('raise RuntimeError("LightGBM is forbidden")\n')
    assert not (tmp_path / "data").exists()
    completed = subprocess.run([sys.executable, str(source / "verify_headline.py")],
                               cwd=tmp_path, text=True, capture_output=True, timeout=30)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "PASS:" in completed.stdout
    assert "-10.8%" in completed.stdout
    assert "-10.0%" in completed.stdout
    assert "359 days" in completed.stdout


@pytest.mark.parametrize("target", ["score", "ci"])
def test_reference_mismatch_is_rejected(target):
    import json

    reference = pd.read_csv(ROOT / "evidence/test_v2_scores.csv")
    reference_ci = json.loads((ROOT / "evidence/test_v2_ci.json").read_text())
    computed = reference.copy()
    computed_ci = {scope: values.copy() for scope, values in reference_ci.items()}
    if target == "score":
        computed.loc[0, "pinball"] += .001
    else:
        computed_ci["Belgium"]["lo"] += .0001
    with pytest.raises(ValueError, match="pinball|CI lo"):
        check_references(computed, computed_ci, reference, reference_ci)
