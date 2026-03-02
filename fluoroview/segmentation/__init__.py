"""Segmentation backends — Cellpose (preferred) or DeepCell (optional).

Detection is fully lazy — no heavy imports at startup.
"""

import importlib


def _check_available(module_name: str) -> bool:
    """Check if a module is importable without actually importing it."""
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ModuleNotFoundError, ValueError):
        return False


HAS_CELLPOSE = _check_available("cellpose")
HAS_DEEPCELL = _check_available("deepcell")
