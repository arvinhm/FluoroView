"""Generated fixtures: small images with the same on-disk layouts as real instrument exports."""

from __future__ import annotations

import time

import numpy as np
import pytest
import tifffile
from fastapi.testclient import TestClient

from fluoroview.config import Settings
from fluoroview.server.app import create_app

TOKEN = "test-token"


@pytest.fixture
def client(tmp_path):
    settings = Settings(token=TOKEN, cache_dir=tmp_path / "cache", projects_dir=tmp_path / "projects",
                        studio_dir=None, extra_hosts=("testserver",))
    with TestClient(create_app(settings)) as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


def wait_ready(client, ds_id: str, timeout: float = 60.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = client.get(f"/api/v1/datasets/{ds_id}").json()
        if d["build"]["state"] == "ready":
            return d
        assert d["build"]["state"] != "failed", d["build"]["error"]
        time.sleep(0.05)
    raise TimeoutError(ds_id)

BIOTEK_CHANNELS = [("DAPI", 377, 447), ("GFP", 469, 525), ("RFP", 531, 593), ("CY5", 628, 685)]

BIOTEK_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<BTIImageMetaData Version="29">
  <System><Gen5><Version>3.09.07</Version></Gen5>
    <Camera><Model>Grasshopper3 GS3-U3-14S5M</Model><SaturationLevel>65520</SaturationLevel></Camera></System>
  <ImageReference><Date>02/19/26</Date><Time>10:56:22</Time><Plate>Image Set 3</Plate><Well>B1</Well>
    <OriginalFilename>D:\\Arvin\\PSGR\\fixture.tif</OriginalFilename></ImageReference>
  <ImageAcquisition>
    <PixelWidth>{w}</PixelWidth><PixelHeight>{h}</PixelHeight>
    <ImageWidthMicrons>{wum}</ImageWidthMicrons><ImageHeightMicrons>{hum}</ImageHeightMicrons>
    <DisplayedObjectiveSize>10x</DisplayedObjectiveSize><ObjectiveMfg>Olympus</ObjectiveMfg>
    <NumericalAperture>0.3</NumericalAperture>
    <Channel Color="Stitched[{name} {ex},{em}]"><BrightField>FALSE</BrightField></Channel>
    <LEDIntensity>10</LEDIntensity><ShutterSpeedMS>100</ShutterSpeedMS><CameraGain>7.2</CameraGain>
  </ImageAcquisition>
</BTIImageMetaData>"""


def make_planes(n: int, h: int, w: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    planes = []
    for c in range(n):
        base = 1500 + 400 * c + (yy * 7 + xx * 3 + c * 911) % 4000
        noise = rng.integers(0, 3000, size=(h, w))
        planes.append(np.clip(base + noise, 0, 65520).astype(np.uint16))
    planes = np.stack(planes)
    planes[0, 10:20, 10:40] = 65520  # saturated block in DAPI
    return planes


@pytest.fixture(scope="session")
def biotek_image(tmp_path_factory):
    h, w = 1103, 1701
    data = make_planes(4, h, w)
    path = tmp_path_factory.mktemp("biotek") / "SSTR2_fixture.tif"
    with tifffile.TiffWriter(path) as tif:
        for c, (name, ex, em) in enumerate(BIOTEK_CHANNELS):
            xml = BIOTEK_XML.format(w=w, h=h, wum=round(w * 0.6578), hum=round(h * 0.6578), name=name, ex=ex, em=em)
            tif.write(data[c], description=xml, rowsperstrip=h, metadata=None, contiguous=False)
    return path, data


@pytest.fixture(scope="session")
def ome_tiled_image(tmp_path_factory):
    data = make_planes(3, 900, 1300, seed=1)
    path = tmp_path_factory.mktemp("ome") / "tiled.ome.tif"
    tifffile.imwrite(path, data, tile=(256, 256), compression="zlib", photometric="minisblack",
                     metadata={"axes": "CYX", "Channel": {"Name": ["Hoechst", "AF488", "AF647"]},
                               "PhysicalSizeX": 0.325, "PhysicalSizeY": 0.325})
    return path, data


def ref_downsample(a: np.ndarray) -> np.ndarray:
    h, w = a.shape
    p = np.pad(a.astype(np.uint32), ((0, h % 2), (0, w % 2)), mode="edge")
    s = p[0::2, 0::2] + p[1::2, 0::2] + p[0::2, 1::2] + p[1::2, 1::2]
    return ((s + 2) >> 2).astype(a.dtype)


def ref_levels(plane: np.ndarray, n_levels: int) -> list[np.ndarray]:
    out = [plane]
    for _ in range(n_levels - 1):
        out.append(ref_downsample(out[-1]))
    return out
