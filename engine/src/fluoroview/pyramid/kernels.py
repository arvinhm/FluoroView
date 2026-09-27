"""Compiled kernels for the pyramid pass: exact histograms and 2x2 area-mean downsampling.

Kernels are single-threaded and release the GIL; the builder runs one channel per thread. Splitting
a kernel across numba threads was slower on Apple silicon because the efficiency cores receive
equal shares and finish last.
"""

from __future__ import annotations

import numba as nb
import numpy as np


@nb.njit(nogil=True, cache=True)
def accumulate_histogram(a, out):
    """Add the value counts of 2-D integer array ``a`` into ``out`` (len(out) > a.max())."""
    for r in range(a.shape[0]):
        row = a[r]
        for x in range(row.shape[0]):
            out[row[x]] += 1


@nb.njit(nogil=True, cache=True)
def downsample2(a):
    """2x2 area mean with round-half-up. Odd edges average the pixels that exist."""
    h, w = a.shape
    oh = (h + 1) // 2
    ow = (w + 1) // 2
    out = np.empty((oh, ow), a.dtype)
    for oy in range(oh):
        y0 = 2 * oy
        y1 = min(y0 + 1, h - 1)
        r0 = a[y0]
        r1 = a[y1]
        for ox in range(ow):
            x0 = 2 * ox
            x1 = min(x0 + 1, w - 1)
            s = np.uint32(r0[x0]) + np.uint32(r0[x1]) + np.uint32(r1[x0]) + np.uint32(r1[x1])
            out[oy, ox] = (s + np.uint32(2)) >> np.uint32(2)
    return out
