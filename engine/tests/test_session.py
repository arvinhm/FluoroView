import json
import shutil
import zipfile
from pathlib import Path

import tifffile

from fluoroview.io import TiffSource
from fluoroview.measure import COLUMNS
from fluoroview.session import SAMPLE_ROWS, content_fingerprint

from .conftest import make_planes, wait_ready

CLIENT_STATE = {
    "view": {"cx": 800.5, "cy": 500.25, "zoom": 2.5, "gallery": True},
    "viewer": {"grid": False, "smooth": True, "clip": True, "minimap": False, "hist_log": False},
    "profile_line": {"x0": 1, "y0": 2, "x1": 300, "y1": 400},
    "export": {"png": True, "dpi": 600},
}


def display(n: int) -> list[dict]:
    return [{"visible": c != 1, "color": "#3d7aff", "lo": 100 + c, "hi": 5000, "gamma": 1.0, "touched": True}
            for c in range(n)]


def fingerprint(path: Path) -> str:
    src = TiffSource(str(path))
    try:
        return content_fingerprint(src)
    finally:
        src.close()


def test_fingerprint_follows_the_pixels_not_the_location_or_layout(tmp_path):
    data = make_planes(3, 700, 1300, seed=4)
    meta = {"axes": "CYX", "Channel": {"Name": ["a", "b", "c"]}}
    plain = tmp_path / "plain.ome.tif"
    tifffile.imwrite(plain, data, photometric="minisblack", rowsperstrip=700, metadata=meta)
    moved = tmp_path / "elsewhere"
    moved.mkdir()
    shutil.copy(plain, moved / plain.name)
    tiled = tmp_path / "tiled.ome.tif"
    tifffile.imwrite(tiled, data, tile=(256, 256), compression="zlib", photometric="minisblack", metadata=meta)
    changed = data.copy()
    changed[1, 700 // (2 * SAMPLE_ROWS)] += 1
    other = tmp_path / "changed.ome.tif"
    tifffile.imwrite(other, changed, photometric="minisblack", rowsperstrip=700, metadata=meta)
    assert fingerprint(plain) == fingerprint(moved / plain.name) == fingerprint(tiled)
    assert fingerprint(other) != fingerprint(plain)


def test_save_inspect_and_restore_a_session(client, biotek_image, tmp_path):
    src, _ = biotek_image
    folder = tmp_path / "scans"
    folder.mkdir()
    image = folder / src.name
    shutil.copy(src, image)
    ds = wait_ready(client, client.post("/api/v1/datasets", json={"path": str(image)}).json()["id"])
    base = f"/api/v1/datasets/{ds['id']}"
    r1 = client.post(f"{base}/regions", json={"shape": "rectangle", "points": [[100, 100], [300, 250]]}).json()
    triangle = {"shape": "polygon", "points": [[500, 500], [700, 520], [600, 700]]}
    r2 = client.post(f"{base}/regions", json=triangle).json()
    client.put(f"{base}/background", json={"region_id": r2["id"]})
    note = client.post(f"{base}/annotations", json={"x": 200, "y": 170, "text": "tumour edge", "author": "AH",
                                                    "region_id": r1["id"]}).json()
    client.post(f"{base}/annotations/{note['id']}/replies", json={"text": "agree", "author": "PH"})

    body = {"path": str(folder / "work"), "display": display(4), **CLIENT_STATE}
    saved = client.post(f"{base}/session", json=body).json()
    assert saved["path"] == str(folder / "work.fv") and saved["bytes"] > 0
    assert client.post(f"{base}/session", json=body).status_code == 409, "never overwrites without asking"
    assert client.post(f"{base}/session", json={**body, "overwrite": True}).status_code == 200
    with zipfile.ZipFile(saved["path"]) as z:
        assert sorted(z.namelist()) == ["manifest.json", "measurements.csv", "session.json", "thumbnail.png"]
        manifest = json.loads(z.read("manifest.json"))
        session = json.loads(z.read("session.json"))
        header = z.read("measurements.csv").decode().splitlines()[0].split(",")
        assert z.read("thumbnail.png").startswith(b"\x89PNG")
    assert (manifest["format"], manifest["version"]) == ("fluoroview-session", 1)
    assert manifest["image"]["names"] == [image.name] and manifest["image"]["paths"] == [str(image)]
    assert manifest["image"]["channels"] == ["DAPI", "GFP", "RFP", "CY5"] and manifest["image"]["dtype"] == "uint16"
    assert manifest["image"]["fingerprint"] == client.get(f"{base}/fingerprint").json()["fingerprint"]
    assert [r["id"] for r in session["regions"]] == [r1["id"], r2["id"]] and session["background_region"] == r2["id"]
    assert session["notes"][0]["replies"][0]["author"] == "PH" and session["view"]["zoom"] == 2.5
    assert session["display"][1]["visible"] is False and header == COLUMNS

    preview = client.get("/api/v1/sessions/thumbnail", params={"path": saved["path"]})
    assert preview.status_code == 200 and preview.content.startswith(b"\x89PNG")
    assert client.get("/api/v1/sessions/thumbnail", params={"path": str(image)}).status_code == 404

    moved = tmp_path / "moved"
    shutil.move(folder, moved)
    fv = moved / "work.fv"
    info = client.post("/api/v1/sessions/inspect", json={"path": str(fv)}).json()
    assert (info["regions"], info["notes"]) == (2, 1)
    assert info["image_paths"] == [str(moved / image.name)], "found next to the session after both moved"

    ds2 = wait_ready(client, client.post("/api/v1/datasets", json={"path": info["image_paths"][0]}).json()["id"])
    base2 = f"/api/v1/datasets/{ds2['id']}"
    client.post(f"{base2}/regions", json={"shape": "ellipse", "points": [[10, 10], [50, 40]]})
    applied = client.post(f"{base2}/session/apply", json={"path": str(fv), "mode": "replace"}).json()
    assert applied["fingerprint_ok"] and applied["channels_match"]
    assert Path(applied["backup"]).is_file(), "the work that was replaced is kept"
    project = applied["project"]
    assert [r["id"] for r in project["regions"]] == [r1["id"], r2["id"]] and project["background_region"] == r2["id"]
    assert project["annotations"][0]["replies"][0]["text"] == "agree" and project["display"][0]["lo"] == 100
    assert applied["view"]["gallery"] is True and applied["viewer"]["smooth"] is True
    assert applied["profile_line"]["x1"] == 300 and applied["export"]["dpi"] == 600

    merged = client.post(f"{base2}/session/apply", json={"path": str(fv), "mode": "merge"}).json()["project"]
    assert len(merged["regions"]) == 4 and len({r["id"] for r in merged["regions"]}) == 4
    assert merged["annotations"][1]["region_id"] == merged["regions"][2]["id"], "the copied note follows its region"
    assert merged["background_region"] == r2["id"]


def test_sessions_refuse_other_images_and_bad_files(opened, ome_tiled_image, tmp_path):
    client, ds, _, _ = opened
    base = f"/api/v1/datasets/{ds['id']}"
    fv = tmp_path / "s.fv"
    body = {"path": str(fv), "display": display(4), **CLIENT_STATE}
    assert client.post(f"{base}/session", json=body).status_code == 200
    tiled, _ = ome_tiled_image
    other = wait_ready(client, client.post("/api/v1/datasets", json={"path": str(tiled)}).json()["id"])
    res = client.post(f"/api/v1/datasets/{other['id']}/session/apply", json={"path": str(fv), "mode": "merge"})
    assert res.status_code == 409 and "another image" in res.json()["detail"]

    junk = tmp_path / "junk.fv"
    junk.write_bytes(b"not a zip")
    assert client.post("/api/v1/sessions/inspect", json={"path": str(junk)}).status_code == 422
    newer = tmp_path / "newer.fv"
    with zipfile.ZipFile(newer, "w") as z:
        z.writestr("manifest.json", json.dumps({"format": "fluoroview-session", "version": 99, "image": {}}))
        z.writestr("session.json", "{}")
    assert "newer FluoroView" in client.post("/api/v1/sessions/inspect", json={"path": str(newer)}).json()["detail"]
    relative = {"path": "relative.fv", "display": display(4), **CLIENT_STATE}
    assert client.post(f"{base}/session", json=relative).status_code == 422
    listing = client.get("/api/v1/fs/list", params={"path": str(tmp_path)}).json()
    assert any(e["name"] == "s.fv" and e.get("session") for e in listing["entries"])
