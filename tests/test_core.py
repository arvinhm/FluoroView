import numpy as np
import pytest
import tempfile
import os


class TestROIData:

    def test_rect_mask(self):
        from fluoroview.core.roi import ROIData
        roi = ROIData("rect", (10, 20, 50, 60))
        mask = roi.get_mask(100, 100, ds_factor=1)
        assert mask.shape == (100, 100)
        assert mask.dtype == bool
        assert mask[30, 30] is np.True_
        assert mask[0, 0] is np.False_

    def test_circle_mask(self):
        from fluoroview.core.roi import ROIData
        roi = ROIData("circle", (20, 20, 80, 80))
        mask = roi.get_mask(100, 100, ds_factor=1)
        assert mask[50, 50] is np.True_
        assert mask[0, 0] is np.False_

    def test_freehand_mask(self):
        from fluoroview.core.roi import ROIData
        pts = [(10, 10), (90, 10), (90, 90), (10, 90)]
        roi = ROIData("freehand", (10, 10, 90, 90), points=pts)
        mask = roi.get_mask(100, 100, ds_factor=1)
        assert mask[50, 50] is np.True_

    def test_serialization_roundtrip(self):
        from fluoroview.core.roi import ROIData
        roi = ROIData("rect", (5, 10, 50, 60), name="test-roi")
        d = roi.to_dict()
        restored = ROIData.from_dict(d)
        assert restored.roi_type == "rect"
        assert restored.bbox == (5, 10, 50, 60)
        assert restored.name == "test-roi"

    def test_ds_factor_scaling(self):
        from fluoroview.core.roi import ROIData
        roi = ROIData("rect", (10, 10, 20, 20))
        mask_1x = roi.get_mask(100, 100, ds_factor=1)
        mask_2x = roi.get_mask(200, 200, ds_factor=2)
        assert mask_2x.sum() > mask_1x.sum()


class TestTileEngine:

    def test_build_lut_shape(self):
        from fluoroview.core.tile_engine import _build_lut
        lut = _build_lut(100, 5000, 1.0, 1.0, (255, 0, 0), max_val=65535)
        assert lut.shape == (65536, 3)
        assert lut.dtype == np.uint8

    def test_build_lut_zero_range(self):
        from fluoroview.core.tile_engine import _build_lut
        lut = _build_lut(100, 100, 1.0, 1.0, (255, 255, 255), max_val=255)
        assert lut.shape == (256, 3)

    def test_apply_channel_lut(self):
        from fluoroview.core.tile_engine import _build_lut, _apply_channel_lut
        lut = _build_lut(0, 255, 1.0, 1.0, (255, 0, 0), max_val=255)
        data = np.array([[0, 128, 255]], dtype=np.uint8)
        result = _apply_channel_lut(data, lut)
        assert result.shape == (1, 3, 3)
        assert result[0, 0, 0] == 0
        assert result[0, 2, 0] == 255
        assert result[0, 2, 1] == 0

    def test_screen_blend(self):
        from fluoroview.core.tile_engine import _screen_blend_u8
        a = np.zeros((2, 2, 3), dtype=np.uint8)
        b = np.full((2, 2, 3), 128, dtype=np.uint8)
        result = _screen_blend_u8(a, b)
        assert result.dtype == np.uint8
        np.testing.assert_array_equal(result, b)

    def test_screen_blend_white(self):
        from fluoroview.core.tile_engine import _screen_blend_u8
        a = np.full((2, 2, 3), 255, dtype=np.uint8)
        b = np.full((2, 2, 3), 255, dtype=np.uint8)
        result = _screen_blend_u8(a, b)
        assert result.max() == 255

    def test_tile_cache(self):
        from fluoroview.core.tile_engine import TileCache
        cache = TileCache(max_size=3)
        cache.put("a", np.zeros((10, 10, 3), dtype=np.uint8))
        cache.put("b", np.ones((10, 10, 3), dtype=np.uint8))
        cache.put("c", np.ones((10, 10, 3), dtype=np.uint8) * 2)
        assert cache.size == 3
        assert cache.get("a") is not None
        cache.put("d", np.ones((10, 10, 3), dtype=np.uint8) * 3)
        assert cache.size == 3

    def test_tile_cache_invalidate(self):
        from fluoroview.core.tile_engine import TileCache
        cache = TileCache(max_size=10)
        cache.put("x", np.zeros((5, 5, 3), dtype=np.uint8))
        assert cache.size == 1
        cache.invalidate()
        assert cache.size == 0


class TestQuantification:

    def test_quantify_cells_basic(self):
        from fluoroview.analysis.quantification import quantify_cells
        mask = np.zeros((50, 50), dtype=np.int32)
        mask[10:20, 10:20] = 1
        mask[30:40, 30:40] = 2
        ch = np.random.rand(50, 50).astype(np.float64) * 100
        result = quantify_cells(mask, [ch], ["marker1"])
        assert len(result["cell_id"]) == 2
        assert "mean_marker1" in result
        assert "median_marker1" in result
        assert "total_marker1" in result
        assert result["area"][0] == 100
        assert result["area"][1] == 100

    def test_quantify_cells_empty(self):
        from fluoroview.analysis.quantification import quantify_cells
        mask = np.zeros((20, 20), dtype=np.int32)
        result = quantify_cells(mask, [np.zeros((20, 20))], ["ch1"])
        assert len(result["cell_id"]) == 0

    def test_quantify_cells_region(self):
        from fluoroview.analysis.quantification import quantify_cells_region
        mask = np.zeros((100, 100), dtype=np.int32)
        mask[10:20, 10:20] = 1
        mask[80:90, 80:90] = 2
        ch = np.ones((100, 100), dtype=np.float64)
        result = quantify_cells_region(mask, [ch], ["m1"], 0, 50, 0, 50)
        assert len(result["cell_id"]) == 1
        assert result["centroid_y"][0] > 10

    def test_cell_data_to_csv(self):
        from fluoroview.analysis.quantification import cell_data_to_csv
        data = {
            "cell_id": np.array([1, 2]),
            "area": np.array([100, 200]),
            "mean_ch1": np.array([10.5, 20.3]),
        }
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
            path = f.name
        try:
            cell_data_to_csv(data, path)
            with open(path) as f:
                lines = f.readlines()
            assert len(lines) == 3
            assert "cell_id" in lines[0]
        finally:
            os.unlink(path)


class TestPhenotype:

    def test_compute_positivity(self):
        from fluoroview.analysis.phenotype import compute_positivity
        cell_data = {
            "cell_id": np.array([1, 2, 3, 4]),
            "mean_CD3": np.array([10.0, 50.0, 30.0, 5.0]),
        }
        pos = compute_positivity(cell_data, "CD3", 25.0)
        assert pos.sum() == 2
        assert pos[1] is np.True_
        assert pos[3] is np.False_

    def test_assign_phenotypes(self):
        from fluoroview.analysis.phenotype import assign_phenotypes
        cell_data = {
            "cell_id": np.array([1, 2]),
            "mean_A": np.array([100.0, 10.0]),
            "mean_B": np.array([5.0, 50.0]),
        }
        thresholds = {"A": 50.0, "B": 25.0}
        phenos = assign_phenotypes(cell_data, thresholds, data_keys=["A", "B"],
                                   markers=["A", "B"])
        assert "A+" in phenos[0]
        assert "B\u2212" in phenos[0]
        assert "A\u2212" in phenos[1]
        assert "B+" in phenos[1]

    def test_phenotype_counts(self):
        from fluoroview.analysis.phenotype import phenotype_counts
        phenos = np.array(["A+ B-", "A+ B-", "A- B+"])
        counts = phenotype_counts(phenos)
        assert counts["A+ B-"] == 2
        assert counts["A- B+"] == 1

    def test_assign_with_display_names(self):
        from fluoroview.analysis.phenotype import assign_phenotypes
        cell_data = {
            "cell_id": np.array([1]),
            "mean_ch1": np.array([100.0]),
            "mean_ch2": np.array([5.0]),
        }
        phenos = assign_phenotypes(cell_data, {"ch1": 50, "ch2": 50},
                                   markers=["CD3", "PD1"],
                                   data_keys=["ch1", "ch2"])
        assert "CD3+" in phenos[0]
        assert "PD1\u2212" in phenos[0]

    def test_auto_threshold(self):
        from fluoroview.analysis.phenotype import auto_threshold
        cell_data = {
            "cell_id": np.arange(100),
            "mean_X": np.concatenate([np.ones(50) * 10, np.ones(50) * 90]),
        }
        t = auto_threshold(cell_data, "X", method="median")
        assert 0 < t < 100

    def test_phenotype_csv_export(self):
        from fluoroview.analysis.phenotype import phenotype_data_to_csv
        cell_data = {
            "cell_id": np.array([1, 2]),
            "mean_A": np.array([10.0, 20.0]),
        }
        phenos = np.array(["A+", "A-"])
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
            path = f.name
        try:
            phenotype_data_to_csv(cell_data, phenos, path)
            with open(path) as f:
                lines = f.readlines()
            assert "phenotype" in lines[0]
            assert len(lines) == 3
        finally:
            os.unlink(path)


class TestAnnotations:

    def test_annotation_roundtrip(self):
        from fluoroview.core.annotations import Annotation
        a = Annotation(x=100, y=200, text="test note")
        d = a.to_dict()
        restored = Annotation.from_dict(d)
        assert restored.x == 100
        assert restored.y == 200
        assert restored.text == "test note"

    def test_reply(self):
        from fluoroview.core.annotations import Annotation, Reply
        a = Annotation(x=0, y=0, text="main")
        r = Reply(text="reply text")
        a.replies.append(r)
        d = a.to_dict()
        restored = Annotation.from_dict(d)
        assert len(restored.replies) == 1
        assert restored.replies[0].text == "reply text"
