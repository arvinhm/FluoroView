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
| `POST` | `/api/spatial/enrichment` | **CoSMoS / CAMSE** — multiscale co-occurrence vs a compartment-stratified null |
| `POST` | `/api/spatial/contrast` | The same statistic under both nulls, for the architecture-vs-interaction contrast |
| `POST` | `/api/spatial/refine` | **CoSMoS / CARE** — confidence-gated annotation refinement with abstention |
| `POST` | `/api/spatial/niches` | **CoSMoS / MOSAIC** — niche discovery, bootstrap stability, dual null |
| `POST` | `/api/spatial/cosmos` | All three in one round trip |
| `GET` | `/api/he2st/panel` | Gene panel available to H&E → spatial transcriptomics |
| `POST` | `/api/he2st` | **Experimental** H&E → per-cell expression (sCellST or fallback) |
| `POST` | `/api/he2expression` | Legacy alias kept for older clients |

## CoSMoS spatial statistics
`cosmos_core.py` is the validated reference implementation (CARE / CAMSE /
MOSAIC) and `spatial.py` only marshals JSON, so the API returns the reference
numbers. It needs **numpy only** — scipy/scikit-learn just make it faster — and
is therefore always available (`capabilities.cosmos`).

The permutation null is **stratified within tissue compartments**. When a request
carries no usable compartment labels the response sets `stratified: false`, and
the UI must not present it as architecture-aware.

## H&E → spatial transcriptomics (sCellST)
`POST /api/he2st` prefers real [sCellST](https://github.com/sysbio-curie/sCellST)
inference and otherwise returns a transparent morphology-derived estimate. The
response always names the model (`"scellst"` vs `"experimental-fallback"`) and
explains any downgrade in `fallbackReason`; it never 500s over a missing optional
dependency.

Real inference needs all three of: the `scellst` package importable, a trained
MIL checkpoint at `$SCELLST_MIL_CKPT`, and an H&E image in the request (sCellST
embeds an image crop around each nucleus, so coordinates alone are not enough).

```bash
pip install -r requirements-scellst.txt   # heavy: GPU + CUDA 11.8
export SCELLST_MIL_CKPT=/abs/path/best_model.ckpt
export SCELLST_SSL_WEIGHTS=imagenet       # or a MoCo v3 checkpoint
curl -s localhost:8010/api/health | jq '.capabilities.scellst, .he2st_backend'
```

> **sCellST is CC BY-NC 4.0 (non-commercial)** and ships **no pretrained
> weights** — you must train the MIL head yourself on gated HEST data. Clear the
> licence before any commercial use. The adapter in `he2st.py` is written against
> the upstream API but **has not been executed here** (no GPU, no weights):
> validate it against your own checkpoint before trusting its output.

### Segmentation backends
Chosen automatically by what's installed, in priority order:

1. **StarDist** (`2D_versatile_he`) — H&E nuclei
2. **Cellpose / Cellpose-SAM** (`cyto3`) — fluorescence & general
3. **scikit-image watershed** — always available, no extra install

Enable the heavy backends by uncommenting them in `requirements.txt`.

## ⚠️ Research-use notice
`/api/he2st` (and its `/api/he2expression` alias) is a **research preview**.
Without trained weights it returns a transparent, morphology-derived estimate in
arbitrary units as a documented stand-in — **not a validated prediction, and not
for clinical or diagnostic use.**

The CoSMoS endpoints are likewise **research software**: they report Monte-Carlo
p-values bounded below by 1/(B+1) and BH-FDR q-values, and are **not validated
for clinical or diagnostic use.**
