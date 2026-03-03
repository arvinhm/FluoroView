"""Segmentation backends — Cellpose (preferred) or DeepCell (optional).

Detection is fully lazy — no heavy imports at startup.
"""

import importlib.util
import os
import platform

if platform.system() == "Darwin":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def _check_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ModuleNotFoundError, ValueError):
        return False


HAS_CELLPOSE = _check_available("cellpose")
HAS_DEEPCELL = _check_available("deepcell")
