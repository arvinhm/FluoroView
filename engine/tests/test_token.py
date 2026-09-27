import os
import stat

import pytest

from fluoroview.config import saved_token


def test_saved_token_is_created_once_and_private(tmp_path):
    path = tmp_path / "FluoroView" / "token"
    first = saved_token(path)
    assert len(first) >= 32 and saved_token(path) == first, "the same token at every launch"
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_saved_token_is_renewed_when_cleared_and_tightened_when_loose(tmp_path):
    path = tmp_path / "token"
    first = saved_token(path)
    path.write_text("")
    second = saved_token(path)
    assert second and second != first
    if os.name != "posix":
        pytest.skip("file modes are POSIX only")
    path.chmod(0o644)
    assert saved_token(path) == second and stat.S_IMODE(path.stat().st_mode) == 0o600
