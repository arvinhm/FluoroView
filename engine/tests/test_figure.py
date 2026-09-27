import io
import json

import numpy as np
import pytest
import tifffile
from PIL import Image, ImageDraw

from fluoroview.figure import Display, _font, format_length, nice_length, plan, read_area, render_channel, to_u8
from fluoroview.pyramid.store import plan_levels

from .conftest import ref_levels

DARK = "#202020"
"""Four channels of this colour can never sum to white, so white pixels are overlays."""


def display(n: int, color: str = DARK, visible=None) -> list[dict]:
    return [{"visible": True if visible is None else c in visible, "color": color, "lo": 0, "hi": 65535, "gamma": 1.0}
            for c in range(n)]


def test_plan_uses_the_finest_level_that_fits():
    levels = plan_levels(20000, 10000)
    p = plan(levels, (0, 0, 20000, 10000), (None, 0, 1), 8000)
    assert p.level == 3 and p.panel_width == 2500 and p.width == 3 * 2500 + 2 * p.gap <= 8000
    small = plan(levels, (100, 100, 900, 700), (None, 0), 8000)
    assert (small.level, small.panel_width, small.panel_height, small.width) == (0, 800, 600, 2 * 800 + small.gap)
    raw = plan(levels, (0, 0, 20000, 10000), (None,), 8000)
    assert raw.level == 2 and (raw.width, raw.height) == (5000, 2500)


def test_render_matches_the_viewer_shader():
    data = np.array([[0, 100, 600, 1100, 5000]], np.uint16)
    rgb = render_channel(data, Display(True, "#ff8000", 100, 1100, 2.0))
    t = np.clip((data.astype(np.float64) - 100) / 1000, 0, 1) ** 0.5
    np.testing.assert_allclose(rgb[..., 0], t, rtol=1e-6)
    np.testing.assert_allclose(rgb[..., 1], t * 128 / 255, rtol=1e-6)
    assert to_u8(rgb)[0, 4].tolist() == [255, 128, 0]


def test_scale_bar_lengths():
    assert nice_length(430) == 200 and nice_length(99) == 50 and nice_length(1.7) == 1
    assert format_length(2000) == "2 mm" and format_length(0.5) == "500 nm" and format_length(200) == "200 µm"


def test_figure_png_and_tiff(opened):
    client, ds, data, path = opened
    base = f"/api/v1/datasets/{ds['id']}"
    body = {"box": [100, 200, 612, 712], "display": display(4)}
    p = client.post(f"{base}/figure", json={**body, "plan_only": True}).json()
    assert p["level"] == 0 and p["panel_width"] == 512 and p["panels"] == ["composite", 0, 1, 2, 3]

    png = client.post(f"{base}/figure", json=body)
    assert png.headers["content-disposition"].endswith('-figure.png"')
    img = Image.open(io.BytesIO(png.content))
    assert img.size == (p["width"], p["height"])
    assert [round(v) for v in img.info["dpi"]] == [300, 300]
    meta = json.loads(img.info["Description"])
    assert meta["source"] == path.name and meta["pyramid_level"] == 0 and meta["area_px"] == [100, 200, 612, 712]
    arr = np.asarray(img)
    d = Display(True, DARK, 0, 65535, 1.0)
    expected = to_u8(sum(render_channel(data[c, 456:457, 356:357], d) for c in range(4)))[0, 0]
    assert arr[256, 256].tolist() == expected.tolist()
    step = p["panel_width"] + (p["width"] - 5 * p["panel_width"]) // 4
    assert arr[256, 2 * step + 256].tolist() == to_u8(render_channel(data[1, 456:457, 356:357], d))[0, 0].tolist()
    assert arr[256, step - 1].tolist() == [255, 255, 255], "white gap between panels"

    tif = client.post(f"{base}/figure", json={**body, "format": "tiff", "dpi": 600})
    with tifffile.TiffFile(io.BytesIO(tif.content)) as tf:
        page = tf.pages[0]
        assert page.shape == (p["height"], p["width"], 3) and page.dtype == np.uint8
        assert page.tags["XResolution"].value == (600, 1)
        assert json.loads(page.description)["source"] == path.name
        np.testing.assert_array_equal(page.asarray(), arr)


def test_figure_burns_in_regions_and_notes(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[150, 250], [400, 500]]})
    client.post(f"{base}/annotations", json={"x": 300, "y": 400, "text": "check"})
    body = {"box": [100, 200, 612, 712], "display": display(4, visible=[0]), "labels": False, "scale_bar": False}
    on = np.asarray(Image.open(io.BytesIO(client.post(f"{base}/figure", json=body).content)))
    off = np.asarray(Image.open(io.BytesIO(client.post(f"{base}/figure", json={**body, "regions": False,
                                                                               "notes": False}).content)))
    assert on[50, 150].tolist() == [255, 255, 255] and off[50, 150].tolist() != [255, 255, 255]
    assert (on[190:210, 190:210] == 255).all(axis=2).sum() > 50, "note pin"
    assert not (off == 255).all(axis=2)[:, :512].any()


def test_scale_bar_and_labels_are_drawn(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    body = {"box": [100, 200, 612, 712], "display": display(4, visible=[0])}
    arr = np.asarray(Image.open(io.BytesIO(client.post(f"{base}/figure", json=body).content)))
    white = (arr[:, :512] == 255).all(axis=2)
    assert white[480:500, 380:500].any(), "scale bar at the bottom right of the composite"
    assert white[:40, :120].any(), "label at the top left"


def test_raw_ome_tiff(opened):
    client, ds, data, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    res = client.post(f"{base}/export.ome.tif", json={"box": [612.4, 712.9, 100, 200]})
    assert res.status_code == 200 and res.headers["content-disposition"].endswith('-area.ome.tif"')
    with tifffile.TiffFile(io.BytesIO(res.content)) as tf:
        assert tf.is_ome
        np.testing.assert_array_equal(tf.series[0].asarray(), data[:, 200:713, 100:613])
        ome = tf.ome_metadata
    assert all(f'Name="{c["name"]}"' in ome for c in ds["channels"])
    assert f'PhysicalSizeX="{ds["pixel_size_um"]}"' in ome
    exports = client.app.state.settings.cache_dir.parent / "exports"
    assert list(exports.glob("*.tif")) == [], "temporary export file removed after sending"


def test_export_rejects_bad_requests(opened):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    ok = display(4)
    assert client.post(f"{base}/figure", json={"box": [5000, 5000, 6000, 6000], "display": ok}).status_code == 422
    assert client.post(f"{base}/figure", json={"box": [0, 0, 10, 10], "display": ok[:2]}).status_code == 422
    hidden = display(4, visible=[])
    assert client.post(f"{base}/figure", json={"box": [0, 0, 10, 10], "display": hidden}).status_code == 422
    assert client.post(f"{base}/export.ome.tif", json={"box": [0, 0, 10, 10], "max_side": 10}).status_code == 422


@pytest.mark.parametrize("fmt", ["png", "tiff"])
def test_figure_is_capped_even_past_the_stored_pyramid(opened, fmt):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    body = {"box": [0, 0, ds["width"], ds["height"]], "display": display(4), "max_side": 1000, "format": fmt}
    p = client.post(f"{base}/figure", json={**body, "plan_only": True}).json()
    assert p["level"] >= len(ds["levels"]) and max(p["width"], p["height"]) <= 1000
    res = client.post(f"{base}/figure", json=body)
    if fmt == "png":
        assert Image.open(io.BytesIO(res.content)).size == (p["width"], p["height"])
    else:
        assert tifffile.imread(io.BytesIO(res.content)).shape == (p["height"], p["width"], 3)


def test_levels_past_the_pyramid_are_exact_means(opened):
    client, ds, data, _ = opened
    dataset = client.app.state.registry.get(ds["id"])
    top = len(ds["levels"]) - 1
    for level in (top, top + 1, top + 2):
        ref = ref_levels(data[2], level + 1)[level]
        box = (0, 0, ref.shape[1], ref.shape[0])
        np.testing.assert_array_equal(read_area(dataset, level, 2, box), ref)
        np.testing.assert_array_equal(read_area(dataset, level, 2, (3, 2, 9, 7)), ref[2:7, 3:9])


def test_scale_bar_text_has_a_micro_sign():
    """Pillow's built-in font draws µ as a missing-glyph box; figures use the studio's typeface."""
    font = _font(40)

    def ink(ch: str) -> np.ndarray:
        im = Image.new("L", (60, 60), 0)
        ImageDraw.Draw(im).text((5, 5), ch, font=font, fill=255)
        return np.asarray(im)

    assert not np.array_equal(ink("µ"), ink("\uffff")), "µ is drawn, not a missing-glyph box"
    assert format_length(20) == "20 µm"
