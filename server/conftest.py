import os
import sys

# Ensure `import app` resolves to server/app.py regardless of pytest's cwd.
sys.path.insert(0, os.path.dirname(__file__))
