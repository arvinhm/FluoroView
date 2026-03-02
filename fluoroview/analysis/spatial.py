"""Spatial queries on segmented cell data.

Uses sklearn BallTree when available; falls back to brute-force numpy.
Adapted from scope2screen data_model.py.
"""

from __future__ import annotations

import numpy as np

try:
    from sklearn.neighbors import BallTree as _BallTree
    _HAS_SKLEARN = True
except Exception:
    _HAS_SKLEARN = False


class SpatialIndex:
    """Fast nearest-neighbour and radius queries over cell centroids."""

    def __init__(self, centroids_y: np.ndarray, centroids_x: np.ndarray,
                 cell_ids: np.ndarray):
        self.coords = np.column_stack([centroids_y, centroids_x])
        self.cell_ids = cell_ids
        self._tree = None
        if _HAS_SKLEARN:
            self._tree = _BallTree(self.coords)

    def nearest(self, x: float, y: float, k: int = 10):
        q = np.array([[y, x]])
        if self._tree is not None:
            dist, idx = self._tree.query(q, k=min(k, len(self.cell_ids)))
            return self.cell_ids[idx[0]], dist[0]
        dists = np.sqrt(np.sum((self.coords - q) ** 2, axis=1))
        idx = np.argsort(dists)[:k]
        return self.cell_ids[idx], dists[idx]

    def neighbourhood(self, x: float, y: float, radius: float = 50):
        q = np.array([[y, x]])
        if self._tree is not None:
            idx = self._tree.query_radius(q, r=radius)[0]
            return self.cell_ids[idx]
        dists = np.sqrt(np.sum((self.coords - q) ** 2, axis=1))
        return self.cell_ids[dists <= radius]

    def all_neighbours(self, radius: float = 50):
        """Return adjacency: ``{cell_id: [neighbour_ids]}``."""
        adj: dict[int, list[int]] = {}
        if self._tree is not None:
            indices = self._tree.query_radius(self.coords, r=radius)
            for i, nbr_idx in enumerate(indices):
                cid = int(self.cell_ids[i])
                adj[cid] = [int(self.cell_ids[j]) for j in nbr_idx if j != i]
        else:
            from scipy.spatial.distance import cdist
            D = cdist(self.coords, self.coords)
            for i in range(len(self.cell_ids)):
                cid = int(self.cell_ids[i])
                nbrs = np.where((D[i] <= radius) & (D[i] > 0))[0]
                adj[cid] = [int(self.cell_ids[j]) for j in nbrs]
        return adj
