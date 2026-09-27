from pathlib import Path

import numpy as np
import pytest
import tifffile

from fluoroview.io import Layout, MultiFileSource, UnsupportedImage
from fluoroview.io.colors import PALETTE
from fluoroview.io.multifile import channel_name_from_file

from .conftest import make_planes, wait_ready

EXAMPLE = Path(__file__).resolve().parents[2] / "example_data"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Nuclei_channel_8.tif", "Nuclei"),
        ("Nuclear_membrane_channel_20.tif", "Nuclear membrane"),
        ("ECM_16.tif", "ECM"),
        ("CD8.ome.tiff", "CD8"),
        ("Ki67.tif", "Ki67"),
        ("CD45_3.tif", "CD45"),
        ("PD1-ch2.tif", "PD1"),
        ("scan_c2.tif", "scan"),
        ("0042.tif", "0042"),
    ],
)
def test_channel_name_from_file(name, expected):
    assert channel_name_from_file(f"/data/{name}") == expected


@pytest.fixture
def channel_files(tmp_path):
    data = make_planes(3, 300, 457, seed=7)
    names = ["ECM_16.tif", "Nuclei_channel_8.tif", "Membrane_channel_25.tif"]
    paths = []
    for plane, name in zip(data, names, strict=True):
        p = tmp_path / name
        tifffile.imwrite(p, plane, photometric="minisblack")
        paths.append(str(p))
    return paths, data


def test_combined_files_have_a_preview(client, channel_files):
    paths, _ = channel_files
    wait_ready(client, client.post("/api/v1/datasets", json={"paths": paths}).json()["id"])
    res = client.get("/api/v1/thumbnail", params={"path": paths, "size": 128})
    assert res.status_code == 200 and res.content.startswith(b"\x89PNG")
    other_order = client.get("/api/v1/thumbnail", params={"path": paths[::-1]})
    assert other_order.status_code == 404, "another combination is another image"


def test_reads_files_as_channels(channel_files):
    paths, data = channel_files
    src = MultiFileSource(paths)
    info = src.info
    assert [c.name for c in info.channels] == ["ECM", "Nuclei", "Membrane"]
    assert info.channels[1].color == PALETTE[0], "the nuclear stain gets blue"
    assert len({c.color for c in info.channels}) == 3
    assert info.layout is Layout.CONTIGUOUS and info.files == tuple(paths)
    assert info.name.endswith("· 3 files") and info.folder == str(Path(paths[0]).parent)
    with src.stream() as handles:
        for c in range(3):
            np.testing.assert_array_equal(src.read_rows(c, 17, 290, fd=handles), data[c, 17:290])
    np.testing.assert_array_equal(src.read_rows(2, 0, 5), data[2, :5])
    src.close()


def test_rejects_files_that_do_not_match(channel_files, tmp_path):
    paths, _ = channel_files
    other = tmp_path / "small.tif"
    tifffile.imwrite(other, np.zeros((10, 10), np.uint16))
    with pytest.raises(UnsupportedImage, match="must match"):
        MultiFileSource([paths[0], str(other)])
    with pytest.raises(UnsupportedImage):
        MultiFileSource([paths[0]])


@pytest.mark.skipif(not EXAMPLE.exists(), reason="example_data not present")
def test_example_data_channels():
    files = [str(EXAMPLE / f) for f in ("Nuclei_channel_8.tif", "Cytoplasm_channel_18.tif", "ECM_16.tif",
                                         "Membrane_channel_25.tif", "Nuclear_membrane_channel_20.tif")]
    src = MultiFileSource(files)
    assert [c.name for c in src.info.channels] == ["Nuclei", "Cytoplasm", "ECM", "Membrane", "Nuclear membrane"]
    assert (src.info.width, src.info.height) == (1063, 704)
    src.close()
