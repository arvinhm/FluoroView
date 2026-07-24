"""
CoSMoS — Compartment-conditioned Selective Multi-scale Spatial analysis.

Vendored, unmodified-in-substance copy of the validated reference implementation
`fluorotme.py` (CoSMoS DESIGN.md), carrying its three components:

  * CARE   — compartment-aware, confidence-weighted graph-regularised label
             refinement with a selective-prediction (abstention) rule.
  * CAMSE  — multiscale cell-type co-occurrence tested against a
             COMPARTMENT-STRATIFIED label-permutation null, with Monte-Carlo
             z-scores, an exact within-pair multiscale max-|z| p-value on shared
             permutations, and Benjamini–Hochberg FDR across pairs.
  * MOSAIC — niche discovery by clustering multiscale composition vectors, with
             bootstrap stability and a dual (global + stratified) null.

The statistics live here rather than in `spatial.py` so the reference stays
auditable against the paper: `spatial.py` only marshals JSON in and out.

numpy is required; scipy/scikit-learn are used when present purely for speed and
every call has a pure-numpy fallback.

RESEARCH SOFTWARE ONLY — NOT a medical device, NOT validated for clinical or
diagnostic use.

References: Ripley (1977) cross-K; Palla et al. 2022 (squidpy) neighbourhood
enrichment; Schürch et al. 2020 / Goltsev et al. 2018 cellular neighbourhoods;
Phipson & Smyth 2010 ((b+1)/(B+1) Monte-Carlo p-values); Benjamini & Hochberg
1995 (FDR); Duchi et al. 2008 (simplex projection).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

# ----------------------------------------------------------------------------
# Optional dependencies (guarded). The module is fully functional with numpy
# alone; scipy/sklearn only accelerate or refine specific steps.
# ----------------------------------------------------------------------------
try:
    from scipy.spatial import cKDTree           # type: ignore
    from scipy.sparse import csr_matrix          # type: ignore
    _HAVE_SCIPY = True
except Exception:                                # pragma: no cover
    _HAVE_SCIPY = False

try:
    from sklearn.cluster import KMeans           # type: ignore
    from sklearn.metrics import (                # type: ignore
        adjusted_rand_score as _sk_ari,
        silhouette_score as _sk_sil,
    )
    _HAVE_SKLEARN = True
except Exception:                                # pragma: no cover
    _HAVE_SKLEARN = False


# ============================================================================
# 0. Small numerical utilities (with fallbacks)
# ============================================================================
def entropy(P: np.ndarray, axis: int = -1, eps: float = 1e-12) -> np.ndarray:
    """Shannon entropy H(p) = -sum p log p (natural log) along `axis`."""
    P = np.clip(P, eps, 1.0)
    return -np.sum(P * np.log(P), axis=axis)


def normalized_certainty(P: np.ndarray) -> np.ndarray:
    """omega_i = 1 - H(p_i)/log K  in [0,1]; 1 => fully certain, 0 => uniform."""
    K = P.shape[1]
    return 1.0 - entropy(P, axis=1) / np.log(K)


def confidence_margin(P: np.ndarray) -> np.ndarray:
    """omega_i = p_(1) - p_(2), the top-two margin in [0,1]. More decisive than
    entropy for gating refinement: a peaked posterior over K classes still has
    appreciable entropy, but a large margin correctly marks it confident."""
    s = np.sort(P, axis=1)
    return np.clip(s[:, -1] - s[:, -2], 0.0, 1.0)


def project_simplex(V: np.ndarray) -> np.ndarray:
    """Euclidean projection of each row of V onto the probability simplex.

    Duchi et al. (2008), O(n K log K). Rows sum to 1, entries >= 0.
    """
    n, K = V.shape
    U = np.sort(V, axis=1)[:, ::-1]
    css = np.cumsum(U, axis=1) - 1.0
    idx = np.arange(1, K + 1)
    cond = U - css / idx > 0
    rho = cond.sum(axis=1)                       # number of positive coords
    rho = np.clip(rho, 1, K)
    theta = css[np.arange(n), rho - 1] / rho
    return np.maximum(V - theta[:, None], 0.0)


def bh_fdr(pvals: np.ndarray, alpha: float = 0.05):
    """Benjamini-Hochberg FDR. Returns (qvalues, reject_mask) preserving order."""
    p = np.asarray(pvals, dtype=float)
    m = p.size
    if m == 0:
        return np.array([]), np.array([], dtype=bool)
    order = np.argsort(p)
    ranked = p[order]
    q_sorted = ranked * m / (np.arange(1, m + 1))
    # enforce monotone non-decreasing q from the top
    q_sorted = np.minimum.accumulate(q_sorted[::-1])[::-1]
    q_sorted = np.clip(q_sorted, 0, 1)
    q = np.empty_like(q_sorted)
    q[order] = q_sorted
    reject = q <= alpha
    return q, reject


def adjusted_rand_index(a: np.ndarray, b: np.ndarray) -> float:
    """Adjusted Rand Index. Uses sklearn if present, else a numpy fallback."""
    if _HAVE_SKLEARN:
        return float(_sk_ari(a, b))
    a = np.asarray(a); b = np.asarray(b)
    ua = {v: i for i, v in enumerate(np.unique(a))}
    ub = {v: i for i, v in enumerate(np.unique(b))}
    ca = np.array([ua[v] for v in a]); cb = np.array([ub[v] for v in b])
    cont = np.zeros((len(ua), len(ub)), dtype=np.int64)
    np.add.at(cont, (ca, cb), 1)
    from math import comb
    sum_comb = sum(comb(int(n), 2) for n in cont.flatten())
    a_comb = sum(comb(int(n), 2) for n in cont.sum(axis=1))
    b_comb = sum(comb(int(n), 2) for n in cont.sum(axis=0))
    n = len(a)
    total = comb(n, 2)
    if total == 0:
        return 1.0
    expected = a_comb * b_comb / total
    maxindex = 0.5 * (a_comb + b_comb)
    if maxindex - expected == 0:
        return 1.0
    return float((sum_comb - expected) / (maxindex - expected))


def _kmeanspp_init(X: np.ndarray, k: int, rng: np.random.Generator) -> np.ndarray:
    n = X.shape[0]
    centers = np.empty((k, X.shape[1]))
    centers[0] = X[rng.integers(n)]
    d2 = np.sum((X - centers[0]) ** 2, axis=1)
    for c in range(1, k):
        probs = d2 / max(d2.sum(), 1e-12)
        centers[c] = X[rng.choice(n, p=probs)]
        d2 = np.minimum(d2, np.sum((X - centers[c]) ** 2, axis=1))
    return centers


def kmeans(X: np.ndarray, k: int, seed: int = 0, n_iter: int = 100, n_init: int = 10):
    """k-means (sklearn if present, else numpy k-means++). Returns (labels, inertia)."""
    if _HAVE_SKLEARN:
        km = KMeans(n_clusters=k, n_init=n_init, random_state=seed).fit(X)
        return km.labels_.astype(int), float(km.inertia_)
    rng = np.random.default_rng(seed)
    best_lab, best_in = None, np.inf
    for _ in range(max(1, n_init // 2)):
        C = _kmeanspp_init(X, k, rng)
        for _ in range(n_iter):
            d = ((X[:, None, :] - C[None, :, :]) ** 2).sum(2)
            lab = d.argmin(1)
            newC = np.array([X[lab == j].mean(0) if np.any(lab == j) else C[j]
                             for j in range(k)])
            if np.allclose(newC, C):
                C = newC; break
            C = newC
        inertia = ((X - C[lab]) ** 2).sum()
        if inertia < best_in:
            best_in, best_lab = inertia, lab
    return best_lab.astype(int), float(best_in)


def silhouette(X: np.ndarray, labels: np.ndarray, rng: np.random.Generator,
               sample: int = 600) -> float:
    """Mean silhouette (subsampled). sklearn if present, else numpy fallback."""
    n = X.shape[0]
    if len(np.unique(labels)) < 2:
        return 0.0
    if n > sample:
        sel = rng.choice(n, sample, replace=False)
        Xs, ls = X[sel], labels[sel]
    else:
        Xs, ls = X, labels
    if len(np.unique(ls)) < 2:
        return 0.0
    if _HAVE_SKLEARN:
        try:
            return float(_sk_sil(Xs, ls))
        except Exception:
            return 0.0
    D = np.sqrt(((Xs[:, None, :] - Xs[None, :, :]) ** 2).sum(2))
    uniq = np.unique(ls)
    sil = np.zeros(len(Xs))
    for i in range(len(Xs)):
        same = ls == ls[i]
        same[i] = False
        a = D[i, same].mean() if same.any() else 0.0
        b = np.inf
        for c in uniq:
            if c == ls[i]:
                continue
            m = ls == c
            if m.any():
                b = min(b, D[i, m].mean())
        sil[i] = 0.0 if max(a, b) == 0 else (b - a) / max(a, b)
    return float(sil.mean())


# ============================================================================
# 1. Neighbour geometry
# ============================================================================
def pairs_within(X_um: np.ndarray, rmax: float):
    """Return (i, j, dist) for all unordered pairs (i<j) within `rmax` (um).

    Uses a KD-tree when scipy is available; otherwise a memory-safe blockwise
    brute-force scan.
    """
    n = X_um.shape[0]
    if _HAVE_SCIPY:
        tree = cKDTree(X_um)
        pr = tree.query_pairs(r=rmax, output_type="ndarray")
        if pr.size == 0:
            return (np.array([], int), np.array([], int), np.array([], float))
        i, j = pr[:, 0], pr[:, 1]
        d = np.sqrt(((X_um[i] - X_um[j]) ** 2).sum(1))
        return i, j, d
    # numpy fallback: blockwise to avoid an N x N matrix
    ii, jj, dd = [], [], []
    block = 512
    r2 = rmax * rmax
    for s in range(0, n, block):
        e = min(s + block, n)
        diff = X_um[s:e, None, :] - X_um[None, :, :]
        d2 = (diff ** 2).sum(2)
        for local, i in enumerate(range(s, e)):
            row = d2[local]
            cand = np.where((row <= r2) & (np.arange(n) > i))[0]
            if cand.size:
                ii.append(np.full(cand.size, i)); jj.append(cand)
                dd.append(np.sqrt(row[cand]))
    if not ii:
        return (np.array([], int), np.array([], int), np.array([], float))
    return np.concatenate(ii), np.concatenate(jj), np.concatenate(dd)


def build_scale_adjacency(X_um, comps, radii_um, mode="annulus",
                          compartment_aware=True):
    """Build one (sparse) directed adjacency per scale.

    Parameters
    ----------
    mode : "annulus" -> ring (radii[s-1], radii[s]] ; scales are decorrelated.
           "disk"    -> cumulative (0, radii[s]] ; Ripley-K-like accumulation.
    compartment_aware : if True, only same-compartment pairs are connected.

    Returns a list (length S) of adjacency operators A_s with A_s.dot(U) defined
    for U of shape (N, K). Adjacency is symmetric (both directions stored) so
    that T = U^T A_s U counts ordered (anchor, neighbour) type relations.
    """
    radii_um = np.asarray(radii_um, float)
    S = radii_um.size
    n = X_um.shape[0]
    i, j, d = pairs_within(X_um, float(radii_um[-1]))

    if compartment_aware and i.size:
        keep = comps[i] == comps[j]
        i, j, d = i[keep], j[keep], d[keep]

    # ring index in [0, S-1]: bins[k-1] < d <= bins[k]
    ring = np.digitize(d, radii_um, right=True)
    ring = np.clip(ring, 0, S - 1)

    adjs = []
    for s in range(S):
        if mode == "annulus":
            m = ring == s
        elif mode == "disk":
            m = ring <= s
        else:
            raise ValueError("mode must be 'annulus' or 'disk'")
        ri, rj = i[m], j[m]
        # store both directions
        rows = np.concatenate([ri, rj])
        cols = np.concatenate([rj, ri])
        adjs.append(_Adjacency(rows, cols, n))
    return adjs


class _Adjacency:
    """Thin adjacency operator supporting .dot(U) via scipy csr or numpy add.at."""

    def __init__(self, rows, cols, n):
        self.n = n
        self.nnz = rows.size
        if _HAVE_SCIPY and rows.size:
            self.A = csr_matrix((np.ones(rows.size), (rows, cols)), shape=(n, n))
            self._sparse = True
        else:
            self.rows, self.cols = rows, cols
            self._sparse = False

    def dot(self, U):
        if self._sparse:
            return self.A.dot(U)
        out = np.zeros((self.n, U.shape[1]))
        if self.nnz:
            np.add.at(out, self.rows, U[self.cols])
        return out


# ============================================================================
# 2. CAMSE -- Compartment-Aware Multi-Scale Enrichment
# ============================================================================
@dataclass
class CAMSEResult:
    types: list
    radii_um: np.ndarray
    mode: str
    compartment_aware: bool
    T_obs: np.ndarray          # (S, K, K) observed statistic
    mu: np.ndarray             # (S, K, K) permutation mean
    sd: np.ndarray             # (S, K, K) permutation std
    z: np.ndarray              # (S, K, K) z-score
    log2e: np.ndarray          # (S, K, K) log2(T_obs / mu) effect size
    p_scale: np.ndarray        # (S, K, K) per-scale two-sided MC p-value
    q_scale: np.ndarray        # (S, K, K) BH q over unordered (pair,scale) tests
    max_absz: np.ndarray       # (K, K) max_s |z| per unordered pair
    p_max: np.ndarray          # (K, K) MC p for the max-|z| statistic
    q_max: np.ndarray          # (K, K) BH q over unordered pairs (primary sig.)
    nar: np.ndarray            # (S, K, K) directed neighbourhood-abundance ratio
    B: int

    def significant_pairs(self, alpha=0.05):
        """List FDR-significant unordered pairs (by q_max) with their peak scale."""
        K = len(self.types)
        out = []
        for a in range(K):
            for b in range(a, K):
                if self.q_max[a, b] <= alpha:
                    s = int(np.argmax(np.abs(self.z[:, a, b])))
                    out.append(dict(
                        a=self.types[a], b=self.types[b],
                        peak_r=float(self.radii_um[s]),
                        z=float(self.z[s, a, b]),
                        log2e=float(self.log2e[s, a, b]),
                        direction="enrichment" if self.z[s, a, b] > 0 else "depletion",
                        q_max=float(self.q_max[a, b]),
                        nar_a_to_b=float(self.nar[s, a, b]),
                        nar_b_to_a=float(self.nar[s, b, a]),
                    ))
        out.sort(key=lambda r: -abs(r["z"]))
        return out


def camse(X_units, comps, marks, radii_um, um_per_unit=0.5, mode="annulus",
          compartment_aware=True, B=299, alpha=0.05, seed=0) -> CAMSEResult:
    """Compartment-Aware Multi-Scale Enrichment.

    Parameters
    ----------
    X_units : (N,2) cell centroids in tissue units.
    comps   : (N,) integer tissue-compartment label per cell.
    marks   : (N,K) non-negative cell-type "mark" matrix U. Use one-hot for hard
              labels, one-hot * confidence for confidence-weighted, or the
              refined posterior Q (soft labels) to fully propagate uncertainty.
    radii_um: iterable of scale radii in micrometres.
    """
    rng = np.random.default_rng(seed)
    X_um = np.asarray(X_units, float) * um_per_unit
    U = np.asarray(marks, float)
    N, K = U.shape
    radii_um = np.asarray(radii_um, float)
    S = radii_um.size

    adjs = build_scale_adjacency(X_um, comps, radii_um, mode, compartment_aware)

    def stat(Umat):
        T = np.empty((S, K, K))
        for s in range(S):
            T[s] = Umat.T @ adjs[s].dot(Umat)
        return T

    T_obs = stat(U)

    # permutation groups: within-compartment (stratified) or global
    if compartment_aware:
        groups = [np.where(comps == c)[0] for c in np.unique(comps)]
    else:
        groups = [np.arange(N)]

    T_perm = np.empty((B, S, K, K))
    perm = np.arange(N)
    for b in range(B):
        for g in groups:
            perm[g] = rng.permutation(g)
        T_perm[b] = stat(U[perm])

    mu = T_perm.mean(0)
    sd = T_perm.std(0, ddof=1)
    sd_safe = np.where(sd > 0, sd, np.inf)
    z = (T_obs - mu) / sd_safe
    z[~np.isfinite(z)] = 0.0

    with np.errstate(divide="ignore", invalid="ignore"):
        log2e = np.where(mu > 0, np.log2(np.where(T_obs > 0, T_obs, np.nan) / mu), 0.0)
    log2e = np.nan_to_num(log2e, nan=0.0, posinf=0.0, neginf=0.0)

    # per-scale two-sided MC p-value (Phipson-Smyth (b+1)/(B+1))
    dev_obs = np.abs(T_obs - mu)
    dev_perm = np.abs(T_perm - mu[None])
    ge = (dev_perm >= dev_obs[None]).sum(0)
    p_scale = (1.0 + ge) / (B + 1.0)

    # exact within-pair multiscale multiplicity: max_s |z| on the SAME perms
    absz_obs = np.abs(z)
    max_absz = absz_obs.max(0)                       # (K,K)
    z_perm = (T_perm - mu[None]) / sd_safe[None]
    z_perm[~np.isfinite(z_perm)] = 0.0
    max_absz_perm = np.abs(z_perm).max(1)            # (B,K,K)
    p_max = (1.0 + (max_absz_perm >= max_absz[None]).sum(0)) / (B + 1.0)

    # directed effect size: mean weighted #b-neighbours per a-anchor
    colsum = U.sum(0)                                 # invariant under perm
    nar = np.zeros((S, K, K))
    for s in range(S):
        denom = np.where(colsum > 0, colsum, np.inf)
        nar[s] = T_obs[s] / denom[:, None]

    # BH FDR across unordered pairs (primary) and across unordered (pair,scale)
    iu = np.triu_indices(K)
    q_max = np.ones((K, K))
    qv, _ = bh_fdr(p_max[iu], alpha)
    q_max[iu] = qv
    q_max = np.minimum(q_max, q_max.T)

    q_scale = np.ones((S, K, K))
    flat_p = np.concatenate([p_scale[s][iu] for s in range(S)])
    qv2, _ = bh_fdr(flat_p, alpha)
    off = 0
    for s in range(S):
        m = iu[0].size
        tmp = np.ones((K, K)); tmp[iu] = qv2[off:off + m]
        q_scale[s] = np.minimum(tmp, tmp.T)
        off += m

    return CAMSEResult(
        types=None, radii_um=radii_um, mode=mode,
        compartment_aware=compartment_aware, T_obs=T_obs, mu=mu, sd=sd, z=z,
        log2e=log2e, p_scale=p_scale, q_scale=q_scale, max_absz=max_absz,
        p_max=p_max, q_max=q_max, nar=nar, B=B,
    )


# ============================================================================
# 3. CARE -- Compartment-Aware Refinement of Embeddings
# ============================================================================
@dataclass
class CAREResult:
    Q: np.ndarray                 # (N,K) refined posterior
    omega: np.ndarray             # (N,) confidence weight used
    prior: np.ndarray             # (M,K) compartment class prior
    raw_pred: np.ndarray          # (N,) argmax of input posterior
    ref_pred: np.ndarray          # (N,) argmax of refined posterior
    entropy_ref: np.ndarray       # (N,) H(q_i)

    def selective(self, tau: float):
        """Selective prediction at entropy threshold tau: returns (mask, coverage)."""
        mask = self.entropy_ref <= tau
        return mask, float(mask.mean())


def _bilateral_graph(X_um, comps, k, radius_um, feats):
    """Candidate kNN edges restricted to same compartment & within radius, with
    bilateral (distance x feature-similarity) weights. Bandwidths are set from
    edge-distance quantiles so that only genuinely *similar* neighbours smooth a
    cell (sharp feature gating), which is what prevents over-smoothing of
    confident minority cells.
    """
    n = X_um.shape[0]
    if _HAVE_SCIPY:
        tree = cKDTree(X_um)
        dist, idx = tree.query(X_um, k=min(k + 1, n))
    else:
        D = np.sqrt(((X_um[:, None, :] - X_um[None, :, :]) ** 2).sum(2))
        idx = np.argsort(D, axis=1)[:, :k + 1]
        dist = np.take_along_axis(D, idx, axis=1)

    ri, rj, d2, fd = [], [], [], []
    for i in range(n):
        for jj in range(1, idx.shape[1]):
            j = int(idx[i, jj]); d = float(dist[i, jj])
            if d > radius_um or comps[j] != comps[i]:
                continue
            ri.append(i); rj.append(j)
            d2.append(d * d)
            fd.append(float(np.sum((feats[i] - feats[j]) ** 2)))
    ri = np.array(ri, int); rj = np.array(rj, int)
    d2 = np.array(d2, float); fd = np.array(fd, float)
    if ri.size == 0:
        return ri, rj, np.array([], float)
    sig2x = max(np.quantile(d2, 0.5), 1e-6)
    sig2f = max(np.quantile(fd, 0.25), 1e-6)        # sharp: only similar cells
    w = np.exp(-d2 / (2 * sig2x)) * np.exp(-fd / (2 * sig2f))
    # symmetrise
    rows = np.concatenate([ri, rj]); cols = np.concatenate([rj, ri])
    wts = np.concatenate([w, w])
    return rows, cols, wts


def care_refine(P, X_units, comps, feats, um_per_unit=0.5, k=12, radius_um=30.0,
                beta_max=0.8, eta=0.15, n_iter=20, prior_smooth=1.0,
                tol=1e-5) -> CAREResult:
    """Confidence-gated, compartment-conditioned bilateral label refinement.

    Mean-field fixed point of a Gaussian-CRF whose unary trust is the per-cell
    certainty omega_i and whose pairwise term is a compartment-restricted,
    feature-gated bilateral kernel:

        q_i <- (1-beta_i) p_i
               + beta_i [ (1-eta) * (sum_j w_ij q_j)/(sum_j w_ij) + eta * pi_{s_i} ]

        beta_i = beta_max * (1 - omega_i),    omega_i = 1 - H(p_i)/log K,
        w_ij   = 1[s_i=s_j] * exp(-||x_i-x_j||^2/2sx^2) * exp(-||f_i-f_j||^2/2sf^2).

    Confident cells (omega~1 => beta~0) keep their evidence p_i; only ambiguous
    cells (large H) are pulled toward feature-similar neighbours and the
    compartment class-prior pi. Every update is a convex combination of simplex
    points, so q_i stays on the simplex and confident minority calls are never
    smoothed away.
    """
    P = np.asarray(P, float)
    N, K = P.shape
    X_um = np.asarray(X_units, float) * um_per_unit
    raw_pred = P.argmax(1)

    omega = normalized_certainty(P)
    # gate smoothing by the top-two MARGIN: a peaked posterior over many classes
    # still has non-trivial entropy, so margin better protects confident cells.
    beta = beta_max * (1.0 - confidence_margin(P))

    comp_ids = np.unique(comps)
    prior = np.full((int(comps.max()) + 1, K), 1.0 / K)
    for c in comp_ids:
        cnt = np.bincount(raw_pred[comps == c], minlength=K).astype(float)
        prior[c] = (cnt + prior_smooth) / (cnt.sum() + prior_smooth * K)
    prior_cell = prior[comps]

    rows, cols, wts = _bilateral_graph(X_um, comps, k, radius_um, feats)
    if _HAVE_SCIPY and rows.size:
        W = csr_matrix((wts, (rows, cols)), shape=(N, N))
        deg = np.asarray(W.sum(1)).ravel()
        def Wdot(Q): return W.dot(Q)
    else:
        deg = np.zeros(N)
        if rows.size:
            np.add.at(deg, rows, wts)
        def Wdot(Q):
            out = np.zeros_like(Q)
            if rows.size:
                np.add.at(out, rows, wts[:, None] * Q[cols])
            return out

    has_nbr = deg > 0
    inv_deg = np.where(has_nbr, 1.0 / np.where(has_nbr, deg, 1.0), 0.0)

    Q = P.copy()
    for _ in range(n_iter):
        nbr = Wdot(Q) * inv_deg[:, None]
        nbr[~has_nbr] = prior_cell[~has_nbr]          # keep normalised if isolated
        target = (1.0 - eta) * nbr + eta * prior_cell
        Qn = (1.0 - beta)[:, None] * P + beta[:, None] * target
        Qn /= Qn.sum(1, keepdims=True)                # guard tiny drift
        if np.max(np.abs(Qn - Q)) < tol:
            Q = Qn; break
        Q = Qn

    return CAREResult(Q=Q, omega=omega, prior=prior, raw_pred=raw_pred,
                      ref_pred=Q.argmax(1), entropy_ref=entropy(Q, axis=1))


# ============================================================================
# 4. MOSAIC -- niche discovery
# ============================================================================
@dataclass
class MOSAICResult:
    labels: np.ndarray            # (N,) niche id per cell
    signatures: np.ndarray        # (n_niches, K) mean composition per niche
    sizes: np.ndarray             # (n_niches,)
    stability_ari: float          # mean bootstrap ARI (global stability)
    sil_obs: float                # observed silhouette
    sil_p: float                  # MC p vs compartment-stratified null
    sil_p_global: float           # MC p vs global null (is there ANY structure?)
    comp_enrichment: np.ndarray   # (n_niches, M) observed/expected vs compartment
    types: list = field(default=None)


def _composition_features(X_um, comps, U, radii_um, compartment_aware):
    adjs = build_scale_adjacency(X_um, comps, radii_um, "annulus", compartment_aware)
    feats = []
    for A in adjs:
        c = A.dot(U)                              # (N,K) weighted neighbour counts
        tot = c.sum(1, keepdims=True)
        feats.append(c / np.where(tot > 0, tot, 1.0))
    return np.concatenate(feats, axis=1)          # (N, K*S)


def discover_niches(X_units, comps, U, radii_um, n_niches=5, um_per_unit=0.5,
                    compartment_aware=True, hard_labels=None, n_boot=15,
                    n_null=25, seed=0) -> MOSAICResult:
    """Multiscale composition clustering + stability + significance + association.

    Reports TWO significance p-values:
      * sil_p_global : vs a global label-permutation null -> is there ANY spatial
        composition structure at all?
      * sil_p        : vs the compartment-stratified null -> does niche structure
        exceed what tissue compartments alone already explain?
    """
    rng = np.random.default_rng(seed)
    X_um = np.asarray(X_units, float) * um_per_unit
    N, K = U.shape

    F = _composition_features(X_um, comps, U, radii_um, compartment_aware)
    Fz = (F - F.mean(0)) / (F.std(0) + 1e-9)
    labels, _ = kmeans(Fz, n_niches, seed=seed)

    sizes = np.bincount(labels, minlength=n_niches)
    # signatures as readable type fractions (hard labels if provided, else marks)
    if hard_labels is not None:
        H = np.zeros((N, K)); H[np.arange(N), hard_labels] = 1.0
    else:
        H = U
    signatures = np.array([H[labels == j].mean(0) if sizes[j] > 0 else np.zeros(K)
                           for j in range(n_niches)])

    aris = []
    for _ in range(n_boot):
        sel = rng.choice(N, int(0.8 * N), replace=False)
        lb, _ = kmeans(Fz[sel], n_niches, seed=int(rng.integers(1 << 30)), n_init=3)
        aris.append(adjusted_rand_index(labels[sel], lb))
    stability = float(np.mean(aris)) if aris else 0.0

    sil_obs = silhouette(Fz, labels, rng)
    strat_groups = [np.where(comps == c)[0] for c in np.unique(comps)]

    def null_p(groups):
        sils = []
        for _ in range(n_null):
            perm = np.arange(N)
            for g in groups:
                perm[g] = rng.permutation(g)
            Fn = _composition_features(X_um, comps, U[perm], radii_um, compartment_aware)
            Fnz = (Fn - Fn.mean(0)) / (Fn.std(0) + 1e-9)
            ln, _ = kmeans(Fnz, n_niches, seed=int(rng.integers(1 << 30)), n_init=3)
            sils.append(silhouette(Fnz, ln, rng))
        return (1.0 + np.sum(np.array(sils) >= sil_obs)) / (n_null + 1.0)

    sil_p = float(null_p(strat_groups))
    sil_p_global = float(null_p([np.arange(N)]))

    M = int(comps.max()) + 1
    cont = np.zeros((n_niches, M))
    np.add.at(cont, (labels, comps), 1.0)
    exp = np.outer(cont.sum(1), cont.sum(0)) / max(cont.sum(), 1.0)
    enr = cont / np.where(exp > 0, exp, np.inf)

    return MOSAICResult(labels=labels, signatures=signatures, sizes=sizes,
                        stability_ari=stability, sil_obs=sil_obs, sil_p=sil_p,
                        sil_p_global=sil_p_global, comp_enrichment=enr)

