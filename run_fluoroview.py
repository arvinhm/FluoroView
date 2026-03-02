#!/usr/bin/env python3
"""Launch FluoroView v2 — works on macOS, Windows, and Linux."""

import sys
import os
import platform

# On macOS, ensure user site-packages (numpy<2) comes first
if platform.system() == "Darwin":
    user_site = os.path.expanduser("~/.local/lib/python3.11/site-packages")
    if os.path.isdir(user_site):
        if user_site in sys.path:
            sys.path.remove(user_site)
        sys.path.insert(0, user_site)
    # Prevent MPS BFloat16 crash on Apple Silicon
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

from fluoroview.app import main

main()
