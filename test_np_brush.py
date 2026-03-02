import numpy as np
from scipy.ndimage import gaussian_filter

# Mock image (RGB uint8)
region = np.zeros((10, 10, 3), dtype=np.uint8)
# Mock mask (boolean-like float)
raw_m = np.zeros((10, 10), dtype=np.float32)
raw_m[2:8, 2:8] = 1.0

m = gaussian_filter(raw_m, sigma=1.0)
mask_px = m > 0.01

alpha = m[:, :, np.newaxis]
tint_alpha = alpha * 0.4

# Perform operation
r_ch = region[:, :, 0].astype(np.float32)
g_ch = region[:, :, 1].astype(np.float32)
b_ch = region[:, :, 2].astype(np.float32)
region[:, :, 0] = np.clip(r_ch + 200 * tint_alpha[:, :, 0], 0, 255).astype(np.uint8)
region[:, :, 1] = np.clip(g_ch * (1 - tint_alpha[:, :, 0]), 0, 255).astype(np.uint8)
region[:, :, 2] = np.clip(b_ch * (1 - tint_alpha[:, :, 0]), 0, 255).astype(np.uint8)

print("Center pixel red:", region[5, 5, 0])
print("Max red value:", region.max())
