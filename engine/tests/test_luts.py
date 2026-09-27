import numpy as np
import pytest
from pydantic import ValidationError

from fluoroview.display import DisplayChannel
from fluoroview.figure import Display, compose, render_channel
from fluoroview.luts import COLORMAPS, LUT_SIZE, channel_lut, colormap_values, curve_values

CURVE = [(0, 0), (0.25, 0.5), (0.75, 0.6), (1, 1)]
SAMPLES = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1.0]
# Shared with studio/src/lib/lut.test.ts: both implementations must give these numbers.
EXPECTED = [0.0, 0.236855, 0.5, 0.543763, 0.555277, 0.565102, 0.6, 0.810719, 1.0]


def test_curve_passes_through_its_points_without_overshoot():
    assert np.allclose(curve_values(CURVE, np.array(SAMPLES)), EXPECTED, atol=1e-6)
    fine = curve_values(CURVE, np.linspace(0, 1, 2001))
    assert np.all(np.diff(fine) >= -1e-12), "monotone points give a monotone curve"
    peak = curve_values([(0, 0), (0.5, 1), (1, 0)], np.linspace(0, 1, 2001))
    assert peak.max() == pytest.approx(1.0) and peak.min() >= 0.0, "no overshoot at a peak"
    assert np.array_equal(curve_values([(0, 0), (1, 1)], np.array(SAMPLES)), SAMPLES)


def test_colour_maps_and_channel_tables():
    assert set(COLORMAPS) == {"grays", "fire", "ice", "viridis", "magma", "inferno"}
    assert np.allclose(colormap_values("grays", np.array([0.0, 0.5, 1.0])), [[0, 0, 0], [0.5] * 3, [1, 1, 1]])
    assert np.allclose(colormap_values("fire", np.array([0.5]))[0], [0.919608, 0.266667, 0.009804], atol=1e-6)
    table = channel_lut("#00ff00", "color", False, CURVE, 0.5, size=5)
    assert np.allclose(table[:, 1], [0, 0.25, 0.277638, 0.3, 0.5], atol=1e-6) and not table[:, [0, 2]].any()
    inverted = channel_lut("#ffffff", "grays", True, [(0, 0), (1, 1)], 1.0)
    assert inverted.shape == (LUT_SIZE, 3) and np.allclose(inverted[0], 1) and np.allclose(inverted[-1], 0)


def test_figures_draw_what_the_viewer_draws():
    data = np.array([[100, 1100, 2100, 5000]], np.uint16)
    plain = Display(True, "#ff00ff", 100, 2100, 2.0)
    t = np.clip((data.astype(np.float32) - 100) / 2000, 0, 1) ** 0.5
    assert np.array_equal(render_channel(data, plain), t[..., None] * np.array([1, 0, 1], np.float32)), \
        "default settings draw exactly as before"
    mapped = Display(True, "#ff00ff", 100, 2100, 1.0, "grays", True, ((0, 0), (1, 1)), 0.5)
    assert np.allclose(render_channel(data, mapped)[0, :, 0], [0.5, 0.25, 0.0, 0.0], atol=1e-3)
    a = np.array([[[0.2, 0.9, 0.0]]], np.float32)
    b = np.array([[[0.5, 0.3, 0.0]]], np.float32)
    assert np.allclose(compose([a, b], "add", a.shape), [[[0.7, 1.2, 0.0]]])
    assert np.allclose(compose([a, b], "max", a.shape), [[[0.5, 0.9, 0.0]]])


def test_display_settings_are_validated_and_default_as_before():
    old = DisplayChannel(visible=True, color="#00ff00", lo=0, hi=100, gamma=1)
    assert (old.lut, old.invert, old.curve, old.intensity) == ("color", False, [(0.0, 0.0), (1.0, 1.0)], 1.0)
    ok = dict(visible=True, color="#00ff00", lo=0, hi=100, gamma=1)
    for bad in ({"curve": [(0, 0), (0.5, 1)]}, {"curve": [(0, 0), (0.6, 0.5), (0.4, 0.6), (1, 1)]},
                {"curve": [(0, 0), (0.5, 1.2), (1, 1)]}, {"lut": "rainbow"}, {"intensity": 1.5}):
        with pytest.raises(ValidationError):
            DisplayChannel(**ok, **bad)
