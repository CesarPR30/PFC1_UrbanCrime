#!/usr/bin/env python3
"""
embed_subgraphs.py

Augments an existing public/hotspots.json with a 2-D subgraph embedding
(`embed2d`) WITHOUT re-downloading the Chicago road network.

It reuses the *exact* embedding logic from preprocess_hotspots.py
(`compute_subgraph_embeddings` and its block builders) — the only difference is
how the two inputs that function needs are reconstructed:

  • adjacency (`adj`)        – rebuilt from the within-basin `edges` already
                               stored in hotspots.json (each edge is a pair of
                               [lat, lng] endpoints), so node IDs become rounded
                               (lat, lng) tuples instead of OSM node ids.
  • per-node monthly counts  – rebuilt by snapping every crime in crimes.csv to
                               its nearest basin node (within a small radius)
                               via a KD-tree, giving the historical footprint
                               series the embedding's history block consumes.

Because the embedding math (NetLSD heat-kernel topology block, road-class block,
per-block standardization + weighting, UMAP projection) lives in
preprocess_hotspots.py, this script is purely a data-prep adapter — there is a
single source of truth for the embedding.

NOTE: the road-class block reads each spot's `roadTypes` histogram, which is
written by the full pipeline (it needs the OSM `highway` tags). Re-embedding an
hotspots.json produced before road classes existed will treat every basin's road
mix as empty; re-run preprocess_hotspots.py once to populate `roadTypes`.

Usage:
    python embed_subgraphs.py
"""

import json

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from preprocess_hotspots import compute_all_similarities, compute_subgraph_embeddings

# Snap radius (degrees) for attributing a crime to a basin node. ~0.0018° ≈ 200 m
# at Chicago's latitude — wide enough to capture the footprint, tight enough to
# stay local. Crimes outside every basin's radius simply don't contribute.
SNAP_RADIUS_DEG = 0.0018


def _coord_key(latlng) -> tuple[float, float]:
    """Stable hashable node id from a [lat, lng] pair (must match across inputs)."""
    return (round(float(latlng[0]), 6), round(float(latlng[1]), 6))


def main() -> None:
    with open("public/hotspots.json", encoding="utf-8") as fh:
        output = json.load(fh)

    months = sorted(output.keys())

    # 1. Rebuild adjacency over (lat, lng) node ids from the stored basin edges,
    #    and stamp each spot with the temporary `_basinIds` field the embedding
    #    step expects (its basin's node ids).
    adj: dict[tuple, set] = {}
    for spots in output.values():
        for spot in spots:
            ids = [_coord_key(n) for n in spot["nodes"]]
            spot["_basinIds"] = ids
            for u in ids:
                adj.setdefault(u, set())
            for (a, b) in spot["edges"]:
                ka, kb = _coord_key(a), _coord_key(b)
                adj.setdefault(ka, set()).add(kb)
                adj.setdefault(kb, set()).add(ka)

    # 2. Rebuild per-node monthly crime counts by snapping crimes to the nearest
    #    basin node within SNAP_RADIUS_DEG (KD-tree over unique basin nodes).
    basin_nodes = sorted(adj.keys())
    node_month_counts: dict[tuple, dict[str, int]] = {n: {} for n in basin_nodes}

    if basin_nodes:
        tree = cKDTree(np.array([[n[0], n[1]] for n in basin_nodes], dtype=np.float64))

        df = pd.read_csv("public/crimes.csv").dropna(subset=["lat", "lng", "date"])
        df["month"] = pd.to_datetime(df["date"], errors="coerce").dt.to_period("M").astype(str)
        df = df[df["month"].isin(set(months))]

        pts = df[["lat", "lng"]].to_numpy(dtype=np.float64)
        dist, idx = tree.query(pts, k=1)
        hit = dist <= SNAP_RADIUS_DEG
        snapped_months = df["month"].to_numpy()[hit]
        snapped_nodes = idx[hit]

        for node_i, m in zip(snapped_nodes, snapped_months):
            node = basin_nodes[node_i]
            node_month_counts[node][m] = node_month_counts[node].get(m, 0) + 1

        print(f"  Snapped {int(hit.sum()):,}/{len(df):,} crimes onto basin footprints")

    # 3. Compute the embedding (identical code path as the full pipeline).
    print("Computing subgraph embeddings (UMAP) …")
    compute_subgraph_embeddings(output, adj, node_month_counts, months)

    # 3b. Refresh the structural+geometric "similarTo" peers too — it only needs
    #     the in-memory spots (no road network), so we can do it here as well and
    #     keep the lightweight re-embed and the full pipeline in sync.
    print("Computing structural similarity (similarTo) …")
    compute_all_similarities(output, top_k=5)

    # 4. Strip temporary fields and write back.
    for spots in output.values():
        for spot in spots:
            spot.pop("_basinIds", None)

    with open("public/hotspots.json", "w", encoding="utf-8") as fh:
        json.dump(output, fh, separators=(",", ":"))
    print("Wrote embed2d into public/hotspots.json")


if __name__ == "__main__":
    main()
