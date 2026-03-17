
import subprocess
import sys
import os
import platform


REQUIRED = [
    "numpy",
    "tifffile",
    "Pillow",
    "scipy",
    "scikit-image",
    "scikit-learn",
    "matplotlib",
    "opencv-python-headless",
    "customtkinter",
]


def _check_and_install():
    missing = []
    import_names = {
        "Pillow": "PIL",
        "scikit-image": "skimage",
        "scikit-learn": "sklearn",
        "opencv-python-headless": "cv2",
        "customtkinter": "customtkinter",
    }
    for pkg in REQUIRED:
        mod = import_names.get(pkg, pkg.replace("-", "_"))
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)

    if missing:
        print(f"[FluoroView] Installing missing packages: {', '.join(missing)}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--quiet"] + missing,
                stdout=sys.stdout, stderr=sys.stderr)
            print("[FluoroView] Installation complete.")
        except subprocess.CalledProcessError:
            print("[FluoroView] WARNING: Some packages failed to install.")
            print(f"  Try manually: pip install {' '.join(missing)}")


_check_and_install()


if platform.system() == "Darwin":
    user_site = os.path.expanduser("~/.local/lib/python3.11/site-packages")
    if os.path.isdir(user_site):
        if user_site in sys.path:
            sys.path.remove(user_site)
        sys.path.insert(0, user_site)
    os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"


from fluoroview.app import main

main()
