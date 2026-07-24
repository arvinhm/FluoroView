"""
CoSMoS spatial-statistics endpoints (`/api/spatial/*`).

This module only marshals JSON into and out of the vendored reference
implementation in `cosmos_core.py` — no statistics are re-derived here, so the
numbers the UI shows are the reference numbers.

  POST /api/spatial/refine      CARE   — confidence-gated annotation refinement
  POST /api/spatial/enrichment  CAMSE  — multiscale co-occurrence vs a
                                         compartment-stratified permutation null
  POST /api/spatial/niches      MOSAIC — niche discovery + stability + dual null
  POST /api/spatial/cosmos      all three in one call

Coordinates arrive in tissue units; `umPerUnit` converts them to micrometres.
RESEARCH USE ONLY — not validated for clinical or diagnostic use.
"""
from __future__ import annotations

from typing import Literal, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from cosmos_core import bh_fdr, camse, care_refine, discover_niches

router = APIRouter(prefix="/api/spatial", tags=["spatial"])

# Guard rails. The permutation loop is O(B · S · nnz · K), so an unbounded
# request from the browser could pin the server for hours.
MAX_CELLS = 200_000
MAX_PERMUTATIONS = 4_999
MAX_SCALES = 12
MAX_TYPES = 64

DISCLAIMER = "Research use only — not validated for clinical or diagnostic use."


class CellIn(BaseModel):
    id: Optional[int | str] = None
    x: float
    y: float
    typeIndex: int = 0
    compartmentIndex: Optional[int] = None


MarkMode = Literal["hard", "confWeighted", "softRaw"]
NullMode = Literal["annulus", "disk"]


class _Base(BaseModel):
    cells: list[CellIn]
    numTypes: int = Field(default=8, ge=1, le=MAX_TYPES)
    umPerUnit: float = Field(default=0.5, gt=0)
    compartmentAware: bool = True
    marks: MarkMode = "confWeighted"
    confidence: Optional[list[float]] = None
    posteriors: Optional[list[list[float]]] = None
    seed: int = 0


class EnrichmentRequest(_Base):
    typeNames: Optional[list[str]] = None
    radiiUm: list[float] = [10, 20, 30, 40, 60]
    mode: NullMode = "annulus"
    numPermutations: int = Field(default=999, ge=19, le=MAX_PERMUTATIONS)
    alpha: float = Field(default=0.05, gt=0, lt=1)


class RefineRequest(BaseModel):
    cells: list[CellIn]
    numTypes: int = Field(default=8, ge=1, le=MAX_TYPES)
    umPerUnit: float = Field(default=0.5, gt=0)
    posteriors: Optional[list[list[float]]] = None
    features: Optional[list[list[float]]] = None
    markers: Optional[list[list[float]]] = None
    kNeighbors: int = Field(default=12, ge=1, le=200)
    radiusUm: float = Field(default=30.0, gt=0)
    betaMax: float = Field(default=0.85, ge=0, le=1)
    eta: float = Field(default=0.15, ge=0, le=1)
    abstainCoverage: float = Field(default=0.9, gt=0, le=1)


class NicheRequest(_Base):
    radiiUm: list[float] = [10, 20, 30, 40]
    numNiches: int = Field(default=6, ge=2, le=32)
    nBoot: int = Field(default=10, ge=0, le=100)
    nNull: int = Field(default=20, ge=0, le=200)


class CosmosRequest(EnrichmentRequest):
    """Aggregate: CARE → marks from refined labels → CAMSE + MOSAIC."""

    numNiches: int = Field(default=6, ge=2, le=32)
    nicheRadiiUm: Optional[list[float]] = None
    nBoot: int = Field(default=6, ge=0, le=100)
    nNull: int = Field(default=10, ge=0, le=200)
    features: Optional[list[list[float]]] = None
    markers: Optional[list[list[float]]] = None
    kNeighbors: int = Field(default=12, ge=1, le=200)
    radiusUm: float = Field(default=30.0, gt=0)
    refine: bool = True


# ---------------------------------------------------------------- helpers ----
def _coords(cells: list[CellIn]) -> np.ndarray:
    if not cells:
        raise HTTPException(422, "No cells supplied.")
    if len(cells) > MAX_CELLS:
        raise HTTPException(413, f"{len(cells):,} cells exceeds the {MAX_CELLS:,}-cell limit; tile the slide and combine results.")
    return np.array([[c.x, c.y] for c in cells], dtype=float)


def _compartments(cells: list[CellIn], aware: bool) -> tuple[np.ndarray, bool]:
    """Compartment vector plus whether stratification is actually meaningful."""
    raw = [c.compartmentIndex for c in cells]
    if not aware or all(v is None for v in raw):
        return np.zeros(len(cells), dtype=int), False
    comps = np.array([0 if v is None else max(0, int(v)) for v in raw], dtype=int)
    # A single observed compartment makes the stratified null identical to global.
    return comps, bool(np.unique(comps).size > 1)


def _validate_radii(radii: list[float]) -> np.ndarray:
    r = np.asarray(radii, dtype=float)
    if r.size == 0 or r.size > MAX_SCALES:
        raise HTTPException(422, f"Supply between 1 and {MAX_SCALES} scale radii.")
    if np.any(r <= 0):
        raise HTTPException(422, "Scale radii must be positive micrometres.")
    if np.any(np.diff(r) <= 0):
        raise HTTPException(422, "Scale radii must be strictly increasing.")
    return r


def _marks(req: _Base | CosmosRequest, n: int) -> np.ndarray:
    """Build the non-negative mark matrix U (N×K) the statistic consumes."""
    K = req.numTypes
    types = np.array([c.typeIndex for c in req.cells], dtype=int)
    if types.min() < 0 or types.max() >= K:
        raise HTTPException(422, f"typeIndex must be within [0, numTypes-1]; got {int(types.min())}..{int(types.max())} for numTypes={K}.")

    if req.marks == "softRaw":
        if not req.posteriors:
            raise HTTPException(422, 'marks="softRaw" needs `posteriors` (N×K raw, not graph-smoothed).')
        U = np.asarray(req.posteriors, dtype=float)
        if U.shape != (n, K):
            raise HTTPException(422, f"posteriors must be {n}×{K}, got {U.shape[0]}×{U.shape[1] if U.ndim > 1 else '?'}.")
        return np.clip(U, 0.0, None)

    w = np.ones(n)
    if req.marks == "confWeighted":
        if not req.confidence:
            raise HTTPException(422, 'marks="confWeighted" needs `confidence` (one weight per cell).')
        w = np.clip(np.asarray(req.confidence, dtype=float), 0.0, None)
        if w.size != n:
            raise HTTPException(422, f"confidence must have {n} entries, got {w.size}.")
    U = np.zeros((n, K))
    U[np.arange(n), types] = w
    return U


def _type_names(names: Optional[list[str]], K: int) -> list[str]:
    if names and len(names) >= K:
        return list(names[:K])
    return [f"Type {i + 1}" for i in range(K)]


def _enrichment_payload(res, names: list[str], alpha: float, stratified: bool) -> dict:
    """Reshape CAMSEResult into the per-pair structure the Spatial view renders."""
    K = len(names)
    S = int(res.radii_um.size)
    radii = [float(r) for r in res.radii_um]
    pairs = []
    for a in range(K):
        for b in range(a, K):
            per_scale = []
            for s in range(S):
                per_scale.append(
                    {
                        "r": radii[s],
                        "z": float(res.z[s, a, b]),
                        "log2e": float(res.log2e[s, a, b]),
                        "p": float(res.p_scale[s, a, b]),
                        "q": float(res.q_scale[s, a, b]),
                        "narAtoB": float(res.nar[s, a, b]),
                        "narBtoA": float(res.nar[s, b, a]),
                    }
                )
            peak = int(np.argmax(np.abs(res.z[:, a, b])))
            z_peak = float(res.z[peak, a, b])
            q_max = float(res.q_max[a, b])
            significant = q_max <= alpha
            pairs.append(
                {
                    "a": a,
                    "b": b,
                    "aName": names[a],
                    "bName": names[b],
                    "perScale": per_scale,
                    "maxAbsZ": float(res.max_absz[a, b]),
                    "pMax": float(res.p_max[a, b]),
                    "qMax": q_max,
                    "peakR": radii[peak],
                    "zAtPeak": z_peak,
                    "log2eAtPeak": float(res.log2e[peak, a, b]),
                    "significant": significant,
                    "direction": ("enrichment" if z_peak > 0 else "depletion") if significant else "none",
                }
            )
    pairs.sort(key=lambda p: -abs(p["zAtPeak"]))
    return {
        "radiiUm": radii,
        "typeNames": names,
        "mode": res.mode,
        "compartmentAware": bool(res.compartment_aware),
        "stratified": stratified,
        "numPermutations": int(res.B),
        "alpha": alpha,
        "pairs": pairs,
        "engine": "server",
        "disclaimer": DISCLAIMER,
    }


def _posteriors_for_refine(req: RefineRequest | CosmosRequest, n: int, K: int) -> np.ndarray:
    """Use supplied posteriors, else a peaked posterior implied by typeIndex."""
    if req.posteriors:
        P = np.asarray(req.posteriors, dtype=float)
        if P.shape != (n, K):
            raise HTTPException(422, f"posteriors must be {n}×{K}.")
        row = P.sum(1, keepdims=True)
        return P / np.where(row > 0, row, 1.0)
    types = np.array([c.typeIndex for c in req.cells], dtype=int)
    if types.min() < 0 or types.max() >= K:
        raise HTTPException(422, "typeIndex out of range for numTypes.")
    # 0.85 on the observed class is a deliberately non-degenerate stand-in: CARE
    # needs headroom to move probability mass, and log(0) would break entropy.
    P = np.full((n, K), 0.15 / max(K - 1, 1))
    P[np.arange(n), types] = 0.85
    return P


def _features_for_refine(req: RefineRequest | CosmosRequest, n: int) -> np.ndarray:
    src = req.features or req.markers
    if not src:
        # No embedding: a constant feature makes the bilateral term neutral, so
        # refinement falls back to purely spatial/compartment smoothing.
        return np.zeros((n, 1))
    F = np.asarray(src, dtype=float)
    if F.shape[0] != n:
        raise HTTPException(422, f"features must have {n} rows, got {F.shape[0]}.")
    mu = F.mean(0)
    sd = F.std(0)
    return (F - mu) / np.where(sd > 0, sd, 1.0)


def _refine_payload(res, coverage: float) -> dict:
    """Add the abstention decision at the τ implied by the requested coverage."""
    H = np.asarray(res.entropy_ref, dtype=float)
    cov = float(min(max(coverage, 1e-6), 1.0))
    # τ is the entropy quantile that retains `coverage` of the cells, matching
    # CAREResult.selective(τ) (keep where H <= τ).
    tau = float(np.quantile(H, cov)) if H.size else 0.0
    abstain = H > tau
    return {
        "refinedTypeIndex": np.asarray(res.ref_pred, dtype=int).tolist(),
        "refinedProbs": np.asarray(res.Q, dtype=float).round(6).tolist(),
        "rawTypeIndex": np.asarray(res.raw_pred, dtype=int).tolist(),
        "entropy": H.round(6).tolist(),
        "confidence": np.asarray(res.omega, dtype=float).round(6).tolist(),
        "abstain": abstain.tolist(),
        "tau": tau,
        "coverage": float(1.0 - abstain.mean()) if H.size else 1.0,
        "changed": int(np.sum(np.asarray(res.ref_pred) != np.asarray(res.raw_pred))),
        "engine": "server",
        "disclaimer": DISCLAIMER,
    }


def _niche_payload(res, names: list[str], n_null: int) -> dict:
    return {
        "nicheOfCell": np.asarray(res.labels, dtype=int).tolist(),
        "signatures": np.asarray(res.signatures, dtype=float).round(6).tolist(),
        "sizes": np.asarray(res.sizes, dtype=int).tolist(),
        "stabilityAri": float(res.stability_ari),
        "silhouette": float(res.sil_obs),
        "pGlobal": float(res.sil_p_global),
        "pStratified": float(res.sil_p),
        "compartmentEnrichment": np.asarray(res.comp_enrichment, dtype=float).round(6).tolist(),
        "typeNames": names,
        "nNull": n_null,
        "engine": "server",
        "disclaimer": DISCLAIMER,
    }


# ----------------------------------------------------------------- routes ----
@router.post("/enrichment")
def enrichment(req: EnrichmentRequest):
    X = _coords(req.cells)
    n = X.shape[0]
    radii = _validate_radii(req.radiiUm)
    comps, stratified = _compartments(req.cells, req.compartmentAware)
    U = _marks(req, n)
    res = camse(
        X,
        comps,
        U,
        radii,
        um_per_unit=req.umPerUnit,
        mode=req.mode,
        compartment_aware=req.compartmentAware and stratified,
        B=req.numPermutations,
        alpha=req.alpha,
        seed=req.seed,
    )
    return _enrichment_payload(res, _type_names(req.typeNames, req.numTypes), req.alpha, stratified)


@router.post("/refine")
def refine(req: RefineRequest):
    X = _coords(req.cells)
    n = X.shape[0]
    comps, _ = _compartments(req.cells, True)
    P = _posteriors_for_refine(req, n, req.numTypes)
    feats = _features_for_refine(req, n)
    res = care_refine(
        P,
        X,
        comps,
        feats,
        um_per_unit=req.umPerUnit,
        k=req.kNeighbors,
        radius_um=req.radiusUm,
        beta_max=req.betaMax,
        eta=req.eta,
    )
    return _refine_payload(res, req.abstainCoverage)


@router.post("/niches")
def niches(req: NicheRequest):
    X = _coords(req.cells)
    n = X.shape[0]
    radii = _validate_radii(req.radiiUm)
    comps, stratified = _compartments(req.cells, req.compartmentAware)
    U = _marks(req, n)
    if req.numNiches >= n:
        raise HTTPException(422, f"numNiches ({req.numNiches}) must be smaller than the cell count ({n}).")
    hard = np.array([c.typeIndex for c in req.cells], dtype=int)
    res = discover_niches(
        X,
        comps,
        U,
        radii,
        n_niches=req.numNiches,
        um_per_unit=req.umPerUnit,
        compartment_aware=req.compartmentAware and stratified,
        hard_labels=hard,
        n_boot=req.nBoot,
        n_null=req.nNull,
        seed=req.seed,
    )
    out = _niche_payload(res, _type_names(None, req.numTypes), req.nNull)
    out["stratified"] = stratified
    return out


@router.post("/cosmos")
def cosmos(req: CosmosRequest):
    """CARE → marks from the refined labels → CAMSE + MOSAIC in one round trip."""
    X = _coords(req.cells)
    n = X.shape[0]
    radii = _validate_radii(req.radiiUm)
    niche_radii = _validate_radii(req.nicheRadiiUm) if req.nicheRadiiUm else radii
    comps, stratified = _compartments(req.cells, req.compartmentAware)
    names = _type_names(req.typeNames, req.numTypes)
    aware = req.compartmentAware and stratified

    refined = None
    if req.refine:
        P = _posteriors_for_refine(req, n, req.numTypes)
        feats = _features_for_refine(req, n)
        care = care_refine(
            P, X, comps, feats,
            um_per_unit=req.umPerUnit, k=req.kNeighbors, radius_um=req.radiusUm,
        )
        refined = _refine_payload(care, 0.9)
        # Downstream marks carry CARE's refined labels weighted by its own
        # confidence, so uncertainty propagates instead of being thrown away.
        hard = np.asarray(care.ref_pred, dtype=int)
        U = np.zeros((n, req.numTypes))
        U[np.arange(n), hard] = np.clip(np.asarray(care.omega, dtype=float), 0.0, None)
    else:
        U = _marks(req, n)
        hard = np.array([c.typeIndex for c in req.cells], dtype=int)

    cam = camse(
        X, comps, U, radii,
        um_per_unit=req.umPerUnit, mode=req.mode, compartment_aware=aware,
        B=req.numPermutations, alpha=req.alpha, seed=req.seed,
    )
    mos = discover_niches(
        X, comps, U, niche_radii,
        n_niches=min(req.numNiches, max(2, n - 1)), um_per_unit=req.umPerUnit,
        compartment_aware=aware, hard_labels=hard,
        n_boot=req.nBoot, n_null=req.nNull, seed=req.seed,
    )
    niche_out = _niche_payload(mos, names, req.nNull)
    niche_out["stratified"] = stratified
    return {
        "refine": refined,
        "enrichment": _enrichment_payload(cam, names, req.alpha, stratified),
        "niches": niche_out,
        "disclaimer": DISCLAIMER,
    }


@router.post("/contrast")
def contrast(req: EnrichmentRequest):
    """Run CAMSE twice — stratified vs global null — for the contrast toggle.

    This is the point of CoSMoS: a pair that only looks enriched under the global
    null is explained by tissue architecture, not by an interaction.
    """
    X = _coords(req.cells)
    n = X.shape[0]
    radii = _validate_radii(req.radiiUm)
    comps, stratified = _compartments(req.cells, True)
    U = _marks(req, n)
    names = _type_names(req.typeNames, req.numTypes)
    common = dict(um_per_unit=req.umPerUnit, mode=req.mode, B=req.numPermutations, alpha=req.alpha, seed=req.seed)
    strat = camse(X, comps, U, radii, compartment_aware=stratified, **common)
    glob = camse(X, np.zeros(n, dtype=int), U, radii, compartment_aware=False, **common)
    return {
        "compartmentAware": _enrichment_payload(strat, names, req.alpha, stratified),
        "global": _enrichment_payload(glob, names, req.alpha, False),
        "stratified": stratified,
        "disclaimer": DISCLAIMER,
    }
