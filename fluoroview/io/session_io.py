"""Read / write ``.fluoroview.npz`` session files."""

from __future__ import annotations

import numpy as np

from fluoroview.core.session import SessionState


def save_session(path: str, state: SessionState) -> None:
    arrays = state.to_arrays()
    np.savez_compressed(path, **arrays)


def load_session(path: str) -> SessionState:
    data = np.load(path, allow_pickle=True)
    return SessionState.from_arrays(data)
