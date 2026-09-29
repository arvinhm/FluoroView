import numpy as np
import pytest
import tifffile

from fluoroview.io import Layout, TiffSource
from fluoroview.io.biotek import parse_channel
from fluoroview.io.colors import PALETTE, TRANSMITTED

from .conftest import BIOTEK_XML, make_planes


@pytest.mark.parametrize(
    ("attr", "expected"),
    [
        ("Stitched[DAPI 377,447]", ("DAPI", 377.0, 447.0)),
        ("DAPI 377,447", ("DAPI", 377.0, 447.0)),
        ("Stitched[Texas Red 586,647]", ("Texas Red", 586.0, 647.0)),
        ("Bright Field", ("Bright Field", None, None)),
        ("", (None, None, None)),
    ],
)
def test_parse_channel(attr, expected):
    assert parse_channel(attr) == expected


def test_biotek_metadata(biotek_image):
    path, data = biotek_image
    src = TiffSource(path)
    info = src.info
    assert info.vendor == "biotek-gen5"
    assert info.layout is Layout.CONTIGUOUS
    assert (info.height, info.width) == data.shape[1:]
    assert [c.name for c in info.channels] == ["DAPI", "GFP", "RFP", "CY5"]
    assert [(c.excitation_nm, c.emission_nm) for c in info.channels][0] == (377.0, 447.0)
    assert [c.color for c in info.channels] == list(PALETTE[:4])
    assert info.saturation == 65520
    assert info.pixel_size_um == pytest.approx(round(1701 * 0.6578) / 1701)
    assert info.acquisition["objective"] == "10x Olympus"
    assert info.acquisition["numerical_aperture"] == 0.3
    src.close()


@pytest.mark.parametrize("fixture", ["biotek_image", "ome_tiled_image"])
def test_read_rows_match_source(fixture, request):
    path, data = request.getfixturevalue(fixture)
    src = TiffSource(path)
    for c in range(data.shape[0]):
        for y0, y1 in [(0, 1), (0, 512), (511, 700), (data.shape[1] - 3, data.shape[1])]:
            rows = src.read_rows(c, y0, y1)
            assert rows.flags.c_contiguous
            np.testing.assert_array_equal(rows, data[c, y0:y1])
    src.close()


def test_biotek_bright_field_is_transmitted(tmp_path):
    h, w = 64, 96
    data = make_planes(2, h, w)
    fluor = BIOTEK_XML.format(w=w, h=h, wum=63, hum=42, name="DAPI", ex=377, em=447)
    bright = (BIOTEK_XML.format(w=w, h=h, wum=63, hum=42, name="X", ex=0, em=0)
              .replace('Color="Stitched[X 0,0]"', 'Color="Stitched[Bright Field]"')
              .replace("<BrightField>FALSE</BrightField>", "<BrightField>TRUE</BrightField>"))
    path = tmp_path / "bf.tif"
    with tifffile.TiffWriter(path) as tif:
        for plane, xml in zip(data, (fluor, bright), strict=True):
            tif.write(plane, description=xml, rowsperstrip=h, metadata=None, contiguous=False)
    src = TiffSource(path)
    assert [(c.name, c.kind) for c in src.info.channels] == [("DAPI", "fluorescence"), ("Bright Field", "transmitted")]
    assert src.info.channels[1].color == TRANSMITTED
    src.close()


def test_samples_stored_as_planes_in_one_page(tmp_path):
    data = make_planes(3, 45, 70)
    path = tmp_path / "planar.tif"
    tifffile.imwrite(path, data, photometric="rgb", planarconfig="separate", compression="zlib", predictor=True,
                     rowsperstrip=7, metadata=None)
    with tifffile.TiffFile(path) as tf:
        assert tf.pages[0].planarconfig == 2
    src = TiffSource(path)
    assert [c.name for c in src.info.channels] == ["Red", "Green", "Blue"]
    assert src.info.layout is Layout.CHUNKED
    for c in range(3):
        np.testing.assert_array_equal(src.read_rows(c, 0, 45), data[c])
        np.testing.assert_array_equal(src.read_rows(c, 13, 31), data[c, 13:31])
        np.testing.assert_array_equal(src.read_segment(c, 20, 5, 60), data[c, 20, 5:60])
    src.close()


def test_ome_tiled_metadata(ome_tiled_image):
    path, _ = ome_tiled_image
    src = TiffSource(path)
    assert src.info.vendor == "ome-tiff"
    assert src.info.layout is Layout.CHUNKED
    assert [c.name for c in src.info.channels] == ["Hoechst", "AF488", "AF647"]
    assert src.info.pixel_size_um == pytest.approx(0.325)
    src.close()


def test_stream_reads_same_bytes(biotek_image):
    path, data = biotek_image
    src = TiffSource(path)
    with src.stream() as fd:
        np.testing.assert_array_equal(src.read_rows(2, 100, 900, fd=fd), data[2, 100:900])
    src.close()
