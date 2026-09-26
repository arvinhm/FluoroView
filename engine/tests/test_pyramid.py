import numpy as np
import pytest
import zarr

from fluoroview.datasets import histogram_summary
from fluoroview.io import TiffSource
from fluoroview.pyramid.builder import PyramidBuilder, band_rows_for
from fluoroview.pyramid.kernels import accumulate_histogram, downsample2
from fluoroview.pyramid.store import PyramidStore, plan_levels

from .conftest import ref_downsample, ref_levels


def assemble(store: PyramidStore, level: int, c: int) -> np.ndarray:
    lvl = store.levels[level]
    out = np.zeros((lvl.height, lvl.width), store.dtype)
    t = store.tile
    for ty in range(lvl.tiles_y(t)):
        for tx in range(lvl.tiles_x(t)):
            chunk = store.read_chunk(level, c, ty, tx)
            assert chunk is not None, (level, c, ty, tx)
            out[ty * t: ty * t + chunk.shape[0], tx * t: tx * t + chunk.shape[1]] = chunk
    return out


@pytest.mark.parametrize("shape", [(1, 1), (2, 3), (7, 5), (512, 513), (1103, 1701)])
def test_downsample_matches_reference(shape):
    a = np.random.default_rng(3).integers(0, 65536, size=shape, dtype=np.uint16)
    np.testing.assert_array_equal(downsample2(a), ref_downsample(a))


def test_histogram_exact():
    a = np.random.default_rng(4).integers(0, 65536, size=(333, 777), dtype=np.uint16)
    out = np.zeros(65536, np.int64)
    accumulate_histogram(a, out)
    accumulate_histogram(a[:10], out)
    expected = np.bincount(a.ravel(), minlength=65536) + np.bincount(a[:10].ravel(), minlength=65536)
    np.testing.assert_array_equal(out, expected)


def test_plan_levels():
    levels = plan_levels(27643, 17482)
    assert [(lv.width, lv.height) for lv in levels] == [
        (27643, 17482), (13822, 8741), (6911, 4371), (3456, 2186), (1728, 1093), (864, 547), (432, 274)]
    assert band_rows_for(len(levels), 512) == 512
    assert band_rows_for(12, 512) == 2048


@pytest.fixture(params=["biotek_image", "ome_tiled_image"])
def built(request, tmp_path):
    path, data = request.getfixturevalue(request.param)
    src = TiffSource(path)
    store = PyramidStore.create(tmp_path / "pyramid.zarr", src.info)
    events = []
    builder = PyramidBuilder(src, store, on_progress=events.append, flush_interval_s=0.0)
    builder.run()
    yield src, store, builder, data, events
    src.close()


def test_levels_and_histograms_exact(built):
    src, store, builder, data, _ = built
    for c in range(data.shape[0]):
        expected = ref_levels(data[c], len(store.levels))
        for level, ref in enumerate(expected):
            np.testing.assert_array_equal(assemble(store, level, c), ref, err_msg=f"level {level} channel {c}")
        np.testing.assert_array_equal(builder.histograms[c], np.bincount(data[c].ravel(), minlength=65536))


def test_progress_is_monotonic_and_complete(built):
    _, store, _, _, events = built
    assert events
    for prev, cur in zip(events, events[1:], strict=False):
        assert all(b >= a for a, b in zip(prev.rows_ready, cur.rows_ready, strict=True))
    assert events[-1].rows_ready == tuple(lv.height for lv in store.levels)
    assert events[-1].fraction == 1.0


def test_store_is_valid_ome_zarr(built):
    _, store, _, data, _ = built
    group = zarr.open_group(store.root, mode="r")
    ms = group.attrs["multiscales"][0]
    assert ms["version"] == "0.4"
    assert [d["path"] for d in ms["datasets"]] == [str(lv.index) for lv in store.levels]
    for level in range(len(store.levels)):
        arr = group[str(level)]
        assert arr.shape == (data.shape[0], store.levels[level].height, store.levels[level].width)
        np.testing.assert_array_equal(arr[1], assemble(store, level, 1))


def test_histogram_summary_excludes_saturation():
    counts = np.zeros(65536, np.int64)
    counts[100] = 50
    counts[200] = 49
    counts[65520] = 1
    s = histogram_summary(counts, 65520, bins=256, complete=True)
    assert s["saturated"] == 1 and s["total"] == 100
    assert s["min"] == 100 and s["max"] == 65520
    assert s["percentiles"]["99.9"] == 200
    assert sum(s["counts"]) == 100
    assert s["range"] == [0, 65521]
