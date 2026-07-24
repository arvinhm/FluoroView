# FluoroView v3 — Backend API (optional)

A small [FastAPI](https://fastapi.tiangolo.com/) companion service that gives the
web client **model-backed** analysis on your own images. The web app runs fully
without it (on-device demo mode); start this server to offload real computation.

## Install & run

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8010
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8010`, so once this is
running the Studio's status chip flips to **backend online**.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Capability probe — reports which backends are installed |
| `POST` | `/api/segment` | Nuclei segmentation from an uploaded image |
| `POST` | `/api/cluster` | Standardize → PCA → KMeans (+ UMAP if installed) |
| `POST` | `/api/he2expression` | **Experimental** H&E → per-cell expression |

### Segmentation backends
Chosen automatically by what's installed, in priority order:

1. **StarDist** (`2D_versatile_he`) — H&E nuclei
2. **Cellpose / Cellpose-SAM** (`cyto3`) — fluorescence & general
3. **scikit-image watershed** — always available, no extra install

Enable the heavy backends by uncommenting them in `requirements.txt`.

## ⚠️ Experimental notice
`/api/he2expression` is a **research preview**. Without trained weights it returns
a transparent, morphology-derived estimate as a documented stand-in — **not a
validated prediction, and not for clinical or diagnostic use.**
