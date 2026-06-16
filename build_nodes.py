#!/usr/bin/env python3
"""
build_nodes.py

Exports per-node crime counts for the "node crime map" validation view.

This is the same snapping that preprocess_hotspots.py does (crime → nearest road
EDGE → nearest ENDPOINT node), but instead of clustering into top-20 basins it
simply emits, for every road node that captured at least one crime, its total
count and a per-month breakdown.  The front-end colours each node relative to
the busiest node and lets you click any node to read its assigned crime count —
which is exactly how you check whether the street-network corners are "pulling"
the crimes the way the heat-map suggests they should.

Requirements:
    pip install osmnx pandas

Usage:
    python build_nodes.py

Output:
    public/nodes.json
"""

import json
import math
import os
from collections import defaultdict

import pandas as pd

try:
    import osmnx as ox
except ImportError:
    raise SystemExit("osmnx not found - run: pip install osmnx")


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * R * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def main() -> None:
    csv_path = "public/crimes.csv"
    print(f"Loading {csv_path} ...")
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["lat", "lng", "date"])
    df["date_parsed"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date_parsed"])
    df["month"] = df["date_parsed"].dt.to_period("M").astype(str)
    print(f"  {len(df):,} crimes - {df['month'].nunique()} months")

    print("\nDownloading Chicago road network (drive, simplified; cached by osmnx) ...")
    ox.settings.log_console = False
    G = ox.graph_from_place("Chicago, Illinois, USA", network_type="drive", simplify=True)
    print(f"  {len(G.nodes):,} nodes - {len(G.edges):,} edges")

    node_latlng: dict[int, tuple[float, float]] = {
        n: (float(d["y"]), float(d["x"])) for n, d in G.nodes(data=True)
    }

    # Snap crimes: nearest road edge, then the nearer of its two endpoint nodes.
    print("\nSnapping crimes to nearest road nodes (edge first, then node) ...")
    lons = df["lng"].values.astype(float)
    lats = df["lat"].values.astype(float)
    nearest_edges = ox.nearest_edges(G, X=lons, Y=lats)

    snap_nodes: list[int] = []
    for i, (u, v, _key) in enumerate(nearest_edges):
        lat_u, lon_u = node_latlng[u]
        lat_v, lon_v = node_latlng[v]
        du = haversine_m(lats[i], lons[i], lat_u, lon_u)
        dv = haversine_m(lats[i], lons[i], lat_v, lon_v)
        snap_nodes.append(u if du <= dv else v)

    df["node"] = snap_nodes
    print(f"  {len(df):,} crimes snapped")

    # Per-node total + per-month breakdown.
    node_total: dict[int, int] = df["node"].value_counts().to_dict()
    node_month: dict[int, dict[str, int]] = defaultdict(dict)
    for (node, m), cnt in df.groupby(["node", "month"]).size().items():
        node_month[int(node)][m] = int(cnt)

    nodes_out: list[dict] = []
    for node, total in node_total.items():
        if node not in node_latlng:
            continue
        lat, lng = node_latlng[node]
        nodes_out.append({
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "n": int(total),
            "m": node_month.get(int(node), {}),
        })

    # Sort by count desc so the front-end can draw busiest-on-top trivially.
    nodes_out.sort(key=lambda d: d["n"], reverse=True)

    out = {
        "max": nodes_out[0]["n"] if nodes_out else 0,
        "months": sorted(df["month"].unique()),
        "nodes": nodes_out,
    }

    out_path = "public/nodes.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))

    kb = os.path.getsize(out_path) / 1024
    print(
        f"\nWrote {out_path}  ({kb:.0f} KB) - "
        f"{len(nodes_out):,} crime nodes - busiest node = {out['max']} crimes"
    )


if __name__ == "__main__":
    main()
