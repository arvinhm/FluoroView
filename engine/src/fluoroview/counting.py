"""Cell Counter tables: every counted point, and counts with densities per category and region."""

from __future__ import annotations

import csv
import io

import numpy as np

from . import __version__
from .regions import contains_points, pixel_count, rings_of

POINT_COLUMNS = ["file", "point_id", "counter", "x_px", "y_px", "x_um", "y_um", "regions", "fluoroview_version"]
COUNT_COLUMNS = ["file", "counter", "region_id", "region", "count", "area_px", "area_um2", "density_per_mm2",
                 "pixel_size_um", "fluoroview_version"]


def _num(value: float | None) -> str:
    return "" if value is None else f"{value:.4f}"


def _write(columns: list[str], rows: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()


def _membership(state: dict) -> tuple[list[dict], np.ndarray]:
    """Points, and a (regions x points) table of which region holds which point."""
    points = state.get("points") or []
    xs = np.array([p["x"] for p in points], dtype=np.float64)
    ys = np.array([p["y"] for p in points], dtype=np.float64)
    table = np.array([contains_points(r["shape"], r["points"], xs, ys, rings_of(r)) for r in state["regions"]],
                     dtype=np.bool_)
    return points, table.reshape(len(state["regions"]), len(points))


def points_csv(scan: str, state: dict, pixel_size: float | None) -> str:
    counters = {c["id"]: c["name"] for c in state.get("counters") or []}
    points, inside = _membership(state)
    rows = []
    for j, p in enumerate(points):
        holders = [r["name"] for i, r in enumerate(state["regions"]) if inside[i, j]]
        rows.append({
            "file": scan, "point_id": p["id"], "counter": counters.get(p["counter"], ""),
            "x_px": _num(p["x"]), "y_px": _num(p["y"]),
            "x_um": _num(p["x"] * pixel_size) if pixel_size else "",
            "y_um": _num(p["y"] * pixel_size) if pixel_size else "",
            "regions": "; ".join(holders), "fluoroview_version": __version__,
        })
    return _write(POINT_COLUMNS, rows)


def counts_csv(scan: str, state: dict, width: int, height: int, pixel_size: float | None) -> str:
    """One row per category and region, then per category over the whole image."""
    points, inside = _membership(state)
    counter_of = np.array([p["counter"] for p in points], dtype=object)
    areas = [(r["id"], r["name"], pixel_count(r["shape"], r["points"], width, height, rings=rings_of(r)), inside[i])
             for i, r in enumerate(state["regions"])]
    areas.append(("", "whole image", width * height, np.ones(len(points), dtype=np.bool_)))
    rows = []
    for c in state.get("counters") or []:
        mine = counter_of == c["id"]
        for rid, name, area_px, held in areas:
            count = int(np.count_nonzero(mine & held))
            area_um2 = area_px * pixel_size**2 if pixel_size else None
            rows.append({
                "file": scan, "counter": c["name"], "region_id": rid, "region": name, "count": count,
                "area_px": area_px, "area_um2": _num(area_um2),
                "density_per_mm2": _num(count / (area_um2 / 1e6)) if area_um2 else "",
                "pixel_size_um": f"{pixel_size:.6f}" if pixel_size else "", "fluoroview_version": __version__,
            })
    return _write(COUNT_COLUMNS, rows)
