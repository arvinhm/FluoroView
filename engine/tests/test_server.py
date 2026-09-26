import io

import numpy as np
import pytest
import tifffile
from PIL import Image
from starlette.websockets import WebSocketDisconnect

from fluoroview.datasets import Dataset, NotReady
from fluoroview.events import EventBus
from fluoroview.io import TiffSource
from fluoroview.pyramid.cache import PyramidCache

from .conftest import TOKEN, ref_levels, wait_ready


def test_api_requires_token(client):
    assert client.get("/api/v1/health", headers={"Authorization": ""}).status_code == 401
    assert client.get("/api/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/v1/health").status_code == 200


def test_rejects_foreign_host(client):
    assert client.get("/api/v1/health", headers={"Host": "attacker.example:80"}).status_code == 421


def test_websocket_requires_token(client):
    no_auth = {"Authorization": ""}
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/api/v1/events", headers=no_auth) as ws:
        ws.receive_json()
    with pytest.raises(WebSocketDisconnect), client.websocket_connect(
            "/api/v1/events?token=wrong", headers=no_auth) as ws:
        ws.receive_json()
    with client.websocket_connect(f"/api/v1/events?token={TOKEN}") as ws:
        assert ws.receive_json()["type"] == "hello"


def test_open_build_and_serve_tiles(client, biotek_image):
    path, data = biotek_image
    r = client.post("/api/v1/datasets", json={"path": str(path)})
    assert r.status_code == 200, r.text
    ds = wait_ready(client, r.json()["id"])
    assert [c["name"] for c in ds["channels"]] == ["DAPI", "GFP", "RFP", "CY5"]
    levels = ds["levels"]
    for c in (0, 3):
        refs = ref_levels(data[c], len(levels))
        for level in (0, 1, len(levels) - 1):
            ty, tx = (1, 2) if level == 0 else (0, 0)
            t = client.get(f"/api/v1/datasets/{ds['id']}/tiles/{level}/{c}/{ty}/{tx}")
            assert t.status_code == 200
            assert t.headers["X-Tile-Final"] == "1"
            h, w = int(t.headers["X-Tile-Height"]), int(t.headers["X-Tile-Width"])
            tile = np.frombuffer(t.content, "<u2").reshape(h, w)
            np.testing.assert_array_equal(tile, refs[level][ty * 512: ty * 512 + h, tx * 512: tx * 512 + w])

    px = client.get(f"/api/v1/datasets/{ds['id']}/pixel", params={"x": 1700, "y": 1102}).json()
    assert px["values"] == [int(v) for v in data[:, 1102, 1700]]

    hist = client.get(f"/api/v1/datasets/{ds['id']}/histogram/0").json()
    assert hist["complete"] and hist["total"] == data[0].size
    assert hist["saturated"] == int((data[0] >= 65520).sum())

    listing = client.get("/api/v1/fs/list", params={"path": str(path.parent)}).json()
    entry = next(e for e in listing["entries"] if e["name"] == path.name)
    assert entry["cached"] is True

    level0 = client.app.state.cache.pyramid_dir(ds["id"]) / "0"
    assert not any(p.is_file() for p in level0.rglob("*") if p.name != ".zarray"), "level 0 is read in place"


def test_thumbnails_only_for_cached_scans(client, biotek_image):
    path, _ = biotek_image
    assert client.get("/api/v1/thumbnail", params={"path": str(path)}).status_code in (200, 404)
    ds = wait_ready(client, client.post("/api/v1/datasets", json={"path": str(path)}).json()["id"])
    r = client.get("/api/v1/thumbnail", params={"path": str(path), "size": 256})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    image = Image.open(io.BytesIO(r.content))
    assert max(image.size) == 256 and image.mode == "RGB"
    assert client.get(f"/api/v1/datasets/{ds['id']}/thumbnail", params={"size": 256}).content == r.content


def test_open_files_as_channels(client, tmp_path):
    data = np.stack([np.full((600, 700), 100 * (c + 1), np.uint16) + np.arange(700, dtype=np.uint16) for c in range(2)])
    paths = []
    for c, name in enumerate(("DAPI.tif", "CD8.tif")):
        tifffile.imwrite(tmp_path / name, data[c])
        paths.append(str((tmp_path / name).resolve()))
    r = client.post("/api/v1/datasets", json={"paths": paths})
    assert r.status_code == 200, r.text
    ds = wait_ready(client, r.json()["id"])
    assert ds["files"] == paths and [c["name"] for c in ds["channels"]] == ["DAPI", "CD8"]
    t = client.get(f"/api/v1/datasets/{ds['id']}/tiles/0/1/1/1")
    tile = np.frombuffer(t.content, "<u2").reshape(int(t.headers["X-Tile-Height"]), int(t.headers["X-Tile-Width"]))
    np.testing.assert_array_equal(tile, data[1, 512:600, 512:700])
    assert client.post("/api/v1/datasets", json={"paths": paths}).json()["id"] == ds["id"]


def test_open_rejects_missing_and_non_tiff(client, tmp_path):
    assert client.post("/api/v1/datasets", json={"path": str(tmp_path / "nope.tif")}).status_code == 404
    other = tmp_path / "notes.txt"
    other.write_text("x")
    assert client.post("/api/v1/datasets", json={"path": str(other)}).status_code == 422


def test_full_resolution_served_before_build(biotek_image, tmp_path):
    path, data = biotek_image
    cache = PyramidCache(tmp_path / "cache", 10**9)
    ds = Dataset(cache.key_for(path), TiffSource(path), cache, EventBus())
    tile, final = ds.tile(0, 2, 2, 3)
    assert final
    np.testing.assert_array_equal(tile, data[2, 1024:1103, 1536:1701])
    with pytest.raises(NotReady):
        ds.tile(1, 0, 0, 0)
    ds.source.close()
