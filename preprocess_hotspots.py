#!/usr/bin/env python3
"""
preprocess_hotspots.py

Computes top-20 crime concentration subgraphs per month for Chicago crime data.

Methodology:
  Greedy BFS clustering on the road network. For each month:
    1. Snap every crime to its nearest road NODE (via nearest edge then nearest endpoint).
    2. Count crimes per node → f(v).
    3. Sort nodes by f desc; iterate as seeds.
    4. From each unclaimed seed, BFS-expand through the road graph to any
       adjacent unclaimed node that also has >= 1 crime (up to max_hops hops).
    5. Basin = connected subgraph of crime-dense road nodes around the seed.
    6. Rank basins by total crimes (hyper-volume) → keep top 20.
    7. Record crime-type breakdown (for PieChart) and node positions.

Requirements:
    pip install osmnx pandas numpy
    pip install gensim            # optional: enables the graph2vec subgraph
                                  # embedding (WL hashing + Doc2Vec); without it
                                  # the pipeline falls back to a NetLSD trace.

Usage:
    python preprocess_hotspots.py

Output:
    public/hotspots.json
"""

import json
import math
import os
from collections import defaultdict, deque

import pandas as pd

try:
    import osmnx as ox
except ImportError:
    raise SystemExit("osmnx not found – run: pip install osmnx")


# ─── POI configuration ────────────────────────────────────────────────────────

_POI_TAGS: dict = {
    "amenity": [
        "restaurant", "fast_food", "cafe",
        "bar", "nightclub",
        "school", "college", "university",
        "hospital", "clinic", "pharmacy",
        "police", "bank",
    ],
    "shop": ["supermarket", "convenience"],
    "leisure": ["park"],
}

_POI_CATEGORY: dict[str, str] = {
    "restaurant": "food", "fast_food": "food", "cafe": "food",
    "bar": "nightlife", "nightclub": "nightlife",
    "school": "education", "college": "education", "university": "education",
    "hospital": "health", "clinic": "health", "pharmacy": "health",
    "police": "police",
    "bank": "finance",
    "supermarket": "retail", "convenience": "retail",
    "park": "park",
}

# Fixed vocabularies used to build the embedding feature blocks.  Keeping them
# fixed (instead of derived from the data) guarantees that every subgraph maps
# to the same column layout, which is what the embedding/UMAP step requires.
POI_CATEGORIES: list[str] = sorted(set(_POI_CATEGORY.values()))
CRIME_TYPES: list[str] = ["THEFT", "ASSAULT", "ROBBERY", "MOTOR VEHICLE THEFT"]


# ─── Road-class configuration ───────────────────────────────────────────────
# The OSM `highway` tag of each road edge tells us whether a street is a big
# arterial (avenue/expressway) or a small residential street.  We fold the many
# raw OSM values into a small, ordered set of classes so each basin gets a
# "what kind of roads is this made of" fingerprint that feeds the embedding.
_ROAD_CATEGORY: dict[str, str] = {
    "motorway": "expressway", "motorway_link": "expressway",
    "trunk": "expressway", "trunk_link": "expressway",
    "primary": "avenue", "primary_link": "avenue",
    "secondary": "avenue", "secondary_link": "avenue",
    "tertiary": "collector", "tertiary_link": "collector",
    "residential": "street", "living_street": "street",
    "unclassified": "street", "road": "street",
    "service": "service",
}

# Ordered from most to least major; "other" catches anything unmapped.
ROAD_CLASSES: list[str] = ["expressway", "avenue", "collector", "street", "service", "other"]


def _road_class(highway) -> str:
    """Fold a raw OSM `highway` value (possibly a list) into one ROAD_CLASSES key."""
    if isinstance(highway, (list, tuple)):
        highway = highway[0] if highway else None
    return _ROAD_CATEGORY.get(highway, "other")


# ─── Geometry ─────────────────────────────────────────────────────────────────

def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * R * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


# ─── Greedy BFS clustering ────────────────────────────────────────────────────

def compute_hotspots(
    node_crimes: dict[int, int],
    adj: dict[int, set],
    top_k: int = 20,
    max_hops: int = 3,
    bridge: int = 1,
) -> list[dict]:
    """
    Greedy, gap-bridging crime-concentration clustering on the road network.

    Seeds are chosen in decreasing crime count order.  From each seed a BFS
    grows through the road graph collecting *crime nodes* (f >= 1).  Crucially
    it is allowed to traverse up to ``bridge`` consecutive **connector** nodes
    — road intersections that carry no crime *this month* — in order to reach
    the next crime node.  Those connectors are then folded into the basin so
    the resulting subgraph is a connected road sub-network.

    WHY THE BRIDGE
    --------------
    The earlier version only expanded into neighbours that themselves carried a
    crime.  In dense, multi-corner zones a single concentration spreads across
    several intersections, and one crime-free corner in the middle would split
    it into several tiny basins (often single nodes).  Validation against the
    heat-map showed real concentrations being fragmented and dropped from the
    top-20 for exactly this reason.  Bridging across short crime-free gaps keeps
    each concentration whole, matching what the heat-map shows.

    Non-overlapping is preserved by claiming only the *crime nodes* (connectors
    are never claimed, so an already-claimed dense core still walls off
    neighbouring basins).  Final ranking is by total crimes in the basin.
    """
    f: dict[int, int] = dict(node_crimes)
    if not f:
        return []

    unclaimed: set[int] = set(f)
    basins: list[dict] = []
    seeds = sorted(f, key=lambda n: f[n], reverse=True)

    for seed in seeds:
        if len(basins) >= top_k:
            break
        if seed not in unclaimed:
            continue

        crime_nodes: set[int] = {seed}   # crime-carrying nodes claimed by this basin
        connectors: set[int] = set()     # crime-free road nodes used to bridge gaps
        pred: dict[int, int | None] = {seed: None}
        # state[node] = (crime_hops_from_seed, empties_since_last_crime_node)
        state: dict[int, tuple[int, int]] = {seed: (0, 0)}
        dq: deque[int] = deque([seed])

        while dq:
            node = dq.popleft()
            ch, emp = state[node]
            if ch >= max_hops:
                continue
            for nbr in adj.get(node, set()):
                if nbr in crime_nodes:
                    continue
                is_crime = f.get(nbr, 0) >= 1
                if is_crime:
                    if nbr not in unclaimed or nbr in state:
                        continue  # claimed by another basin, or already reached
                    crime_nodes.add(nbr)
                    pred[nbr] = node
                    state[nbr] = (ch + 1, 0)
                    dq.append(nbr)
                    # Commit the crime-free connectors that bridged us here.
                    p = node
                    while p is not None and p not in crime_nodes:
                        connectors.add(p)
                        p = pred[p]
                else:
                    # Crime-free connector: traverse only while the gap budget
                    # holds and we have not seen it on a shorter path.
                    if f.get(nbr, 0) == 0 and emp + 1 <= bridge and nbr not in state:
                        pred[nbr] = node
                        state[nbr] = (ch, emp + 1)
                        dq.append(nbr)

        basin = crime_nodes | connectors
        unclaimed -= crime_nodes
        total = sum(f.get(n, 0) for n in crime_nodes)
        basins.append(
            dict(
                seed=seed,
                basin=basin,
                total_crimes=total,
                peak_crimes=f[seed],
            )
        )

    basins.sort(key=lambda b: b["total_crimes"], reverse=True)
    return basins[:top_k]


# ─── Topological similarity ───────────────────────────────────────────────────

# Conversion factor for the local equirectangular projection that turns the
# (lat, lng) node coordinates into metres.  1° of latitude ≈ 111.32 km; 1° of
# longitude is scaled by cos(latitude).  Plenty accurate for a basin a few km
# across, and it lets every geometric feature be expressed in real metres.
_M_PER_DEG = 111_320.0


def _geometry_features(spot: dict) -> list[float]:
    """
    Metric *shape* descriptors of a subgraph from its node coordinates.

    Connectivity-only descriptors (degree histogram, NetLSD heat trace) are
    blind to geometry: a tight, straight 3-node chain and a sprawling,
    L-shaped 3-node chain are the *same* graph (the path P₃) and so come out
    identical — yet on the map they are obviously different places.  These four
    features add the distances and the shape the analyst actually sees:

      meanEdge    – log mean edge length in metres: how *close* adjacent nodes
                    are (a compact cluster vs. a stretched-out corridor),
      cvEdge      – coefficient of variation of edge lengths (uniform vs. mixed
                    spacing),
      extent      – log radius of gyration in metres (overall spatial size),
      elongation  – √(λ₂/λ₁) of the node-coordinate covariance, in [0, 1]:
                    ~0 for a perfectly straight / linear footprint, →1 for an
                    isotropic blob or a bent (L/T) one.  This is the feature
                    that separates "lineal" from "forma de L".

    Returns four zeros for degenerate (0- or 1-node) basins.
    """
    import numpy as np

    nodes = spot.get("nodes") or []
    if len(nodes) < 2:
        return [0.0, 0.0, 0.0, 0.0]

    pts = np.asarray(nodes, dtype=np.float64)  # columns: [lat, lng]
    cos_lat = math.cos(math.radians(float(pts[:, 0].mean())))

    # Local metres, centred on the centroid (x = east, y = north).
    xy = np.column_stack((
        (pts[:, 1] - pts[:, 1].mean()) * _M_PER_DEG * cos_lat,
        (pts[:, 0] - pts[:, 0].mean()) * _M_PER_DEG,
    ))

    # Edge lengths in metres.
    lengths = np.array(
        [
            math.hypot((b[1] - a[1]) * _M_PER_DEG * cos_lat, (b[0] - a[0]) * _M_PER_DEG)
            for a, b in spot.get("edges", [])
        ],
        dtype=np.float64,
    )
    if lengths.size:
        mean_edge = float(lengths.mean())
        cv_edge = float(lengths.std() / mean_edge) if mean_edge > 1e-9 else 0.0
    else:
        mean_edge, cv_edge = 0.0, 0.0

    # Radius of gyration = RMS distance of the nodes to their centroid.
    gyration = float(np.sqrt((xy ** 2).sum(axis=1).mean()))

    # Shape anisotropy from the coordinate-covariance eigenvalues λ1 ≥ λ2 ≥ 0
    # (eigvalsh returns them ascending).
    evals = np.clip(np.linalg.eigvalsh(np.cov(xy, rowvar=False)), 0.0, None)
    lo, hi = float(evals[0]), float(evals[1])
    elongation = math.sqrt(lo / hi) if hi > 1e-9 else 0.0

    return [math.log1p(mean_edge), cv_edge, math.log1p(gyration), elongation]


def _feature_vector(spot: dict) -> list | None:
    """14-dim structural feature vector for one hotspot (10 connectivity + 4 geometry)."""
    node_count = len(spot["nodes"])
    edge_count = len(spot["edges"])
    if node_count == 0:
        return None

    # Reconstruct in-basin degree for each node via edge list
    deg: dict[tuple, int] = defaultdict(int)
    for edge in spot["edges"]:
        deg[tuple(edge[0])] += 1
        deg[tuple(edge[1])] += 1
    degrees = list(deg.values()) + [0] * (node_count - len(deg))

    max_possible = node_count * (node_count - 1) / 2
    density = edge_count / max_possible if max_possible > 0 else 0.0
    mean_deg = sum(degrees) / node_count

    # Degree histogram: fraction of nodes with in-basin degree 1 / 2 / 3 / 4+
    hist = [0, 0, 0, 0]
    for d in degrees:
        if d > 0:
            hist[min(d - 1, 3)] += 1
    hist_frac = [h / node_count for h in hist]

    total = spot["crimes"]
    peak = spot["peakCrimes"]
    return [
        math.log1p(node_count),
        math.log1p(edge_count),
        density,
        mean_deg,
        peak / total if total > 0 else 0.0,
        math.log1p(total / node_count) if node_count > 0 else 0.0,
        *hist_frac,              # 4 values → 10 connectivity dims so far
        *_geometry_features(spot),  # 4 metric shape dims → 14 total
    ]


def compute_all_similarities(output: dict, top_k: int = 5) -> None:
    """
    Compute pairwise structural cosine-similarity between every hotspot across
    all months and add a 'similarTo' list in-place to each hotspot entry.

    The feature vector mixes connectivity (size, density, degree mix) with
    metric geometry (inter-node distances + shape), so a linear chain and an
    L-shaped chain with the same connectivity are no longer treated as twins.
    """
    import numpy as np

    keys: list[tuple[str, int]] = []
    vecs: list[list[float]] = []

    for month, spots in output.items():
        for spot in spots:
            fv = _feature_vector(spot)
            if fv is not None:
                keys.append((month, spot["rank"]))
                vecs.append(fv)

    # Initialise empty lists for all hotspots
    for month, spots in output.items():
        for spot in spots:
            spot["similarTo"] = []

    if len(vecs) < 2:
        return

    F = np.array(vecs, dtype=np.float64)

    # Min-max normalise each feature column to [0, 1]
    col_min = F.min(axis=0)
    col_max = F.max(axis=0)
    col_range = np.where(col_max > col_min, col_max - col_min, 1.0)
    F_norm = (F - col_min) / col_range

    # Row-normalise for cosine similarity
    norms = np.linalg.norm(F_norm, axis=1, keepdims=True)
    norms = np.where(norms > 0, norms, 1.0)
    F_unit = F_norm / norms

    sim = F_unit @ F_unit.T  # (N, N) cosine similarity matrix

    key_to_idx = {k: i for i, k in enumerate(keys)}

    for month, spots in output.items():
        for spot in spots:
            key = (month, spot["rank"])
            i = key_to_idx.get(key)
            if i is None:
                continue
            row = sim[i]
            sorted_idx = np.argsort(row)[::-1]
            similar: list[dict] = []
            for j in sorted_idx:
                if j == i:
                    continue
                m_j, r_j = keys[j]
                similar.append({
                    "month": m_j,
                    "rank": r_j,
                    "similarity": round(float(row[j]), 3),
                })
                if len(similar) >= top_k:
                    break
            spot["similarTo"] = similar

    print(f"  Similarity computed for {len(keys)} hotspots across {len(output)} months")


# ─── Subgraph embedding (for the left-hand UMAP) ──────────────────────────────
#
# GOAL
# ----
# Produce one fixed-length descriptor per crime subgraph (basin) built ONLY from
# the road network itself — no crime, no POIs, no history leak into the layout:
#
#   1. Topology   – the *shape* of the road sub-network of the basin.
#   2. Road class – the OSM road hierarchy it is made of (expressway / avenue /
#                   collector / street / service): is this an arterial corner or
#                   a residential block?
#
# We then reduce every descriptor to 2-D with UMAP so the front-end can scatter
# all ~480 subgraphs on the left panel.  Subgraphs that are structurally and
# road-type-wise alike end up close together in that 2-D map.  (The raw history
# series and the POI / crime mixes are still stored per spot for the side
# charts — they simply no longer influence the embedding coordinates.)
#
# WHY THIS DESIGN (closest literature)
# ------------------------------------
# • Topology block — graph2vec (primary), NetLSD heat trace (fallback).
#       graph2vec — Narayanan et al., "graph2vec: Learning Distributed
#       Representations of Graphs", MLG 2017.  Each basin's induced road
#       sub-network is turned into a "document" of Weisfeiler-Lehman subtree
#       patterns and embedded with doc2vec, so the representation is *learned
#       jointly over the whole corpus* of basins: the axes adapt to the
#       sub-networks we actually have, and recurring motifs (a 4-way junction, a
#       short cul-de-sac chain) get nearby vectors.  This replaces the earlier
#       NetLSD-first choice now that the corpus (~480 basins) is large enough
#       for the doc2vec step to learn a stable vocabulary of WL subtrees.  It is
#       implemented directly on gensim's Doc2Vec (see _graph2vec_signatures), so
#       there is no karateclub dependency to clash with osmnx / Python 3.13.
#       If `gensim` is not installed (or the fit fails) we fall back to the
#       NetLSD heat-kernel trace  h(t) = Σ_i exp(-t·λ_i)  of the normalized
#       Laplacian (Tsitsulin et al., "NetLSD: Hearing the Shape of a Graph",
#       KDD 2018) — a permutation- and size-invariant multi-scale spectral
#       signature — so the pipeline always emits a topology signature.
#       Either way we append a couple of classic, human-readable stats
#       (log-size, density, mean degree) plus the metric-geometry features, so
#       absolute scale and real-world shape stay available: graph2vec, like
#       NetLSD, is blind to metric geometry (a tight straight chain and a
#       sprawling L are the same graph to it).
#
# • Road-class block — "bag of road hierarchies".
#       Each basin edge carries an OSM `highway` tag; we fold those into a small
#       ordered set of classes (expressway / avenue / collector / street /
#       service) and encode the basin as its normalized distribution over them
#       plus the dominant-class share.  This is the signal that lets two basins
#       with the *same shape* but different street types — an avenue crossing vs.
#       a quiet residential corner — land in different regions of the UMAP.
#
# • Fusion + projection.
#       Each block is z-scored independently (so no block dominates by raw
#       scale), scaled by a tunable weight, then concatenated.  The fused matrix
#       is projected with UMAP (McInnes & Healy, 2018) using the cosine metric.
#       If `umap-learn` is unavailable we fall back to a 2-component PCA so the
#       pipeline always emits coordinates.

# Per-block weights — tune to taste (higher = more influence on the 2-D layout).
# Only topology and road class feed the embedding now (see _EMBED_VARIANTS).
_EMBED_WEIGHTS = {"topo": 1.0, "road": 1.0}

# graph2vec output dimensionality (reduced to 2-D by UMAP afterwards).  64 is
# ample for the small road sub-networks here; the default 128 would mostly add
# noise on graphs of 1–63 nodes.
_GRAPH2VEC_DIMS = 64

# The two embedding *spaces* exposed to the front-end.  Each one is a UMAP
# projection of a different subset of blocks, so the analyst can choose what
# "similar" means.  Both are crime-free by design: crime is the *outcome*
# variable, so it must never shape the layout (otherwise "similar zones with
# different crime" would be contradictory by construction).
#
#   topo      – road-network *shape* only (graph2vec signature — or a NetLSD
#               heat trace if gensim is absent — + structural stats + metric
#               geometry).  Zones close here share topology only.
#   topoRoad  – shape + road hierarchy (the OSM highway class: expressway /
#               avenue / collector / street / service).  Two basins with the
#               same shape but built of avenues vs. residential streets now
#               separate, which is what the analyst sees on the map.
_EMBED_VARIANTS: dict[str, list[str]] = {
    "topo": ["topo"],
    "topoRoad": ["topo", "road"],
}
# JSON field each variant is written to (`embed2d` stays the primary/default).
_EMBED_FIELD = {"topo": "embedTopo", "topoRoad": "embed2d"}

# Log-spaced heat-kernel timescales (NetLSD samples h(t) over many scales; 16 is
# a compact choice that still spans local→global structure for small graphs).
def _heat_timescales(k: int = 16):
    import numpy as np
    return np.logspace(-2, 2, k)


def _heat_trace_signature(basin_ids: list[int], adj: dict[int, set], timescales) -> list[float]:
    """
    NetLSD-style heat-kernel trace of the basin's induced road sub-network.

    Builds the induced subgraph over `basin_ids`, forms the *normalized*
    Laplacian  L = I − D^{-1/2} A D^{-1/2}, takes its eigenvalues λ, and returns
    the size-normalized heat trace  (1/n)·Σ_i exp(-t·λ_i)  at each timescale t.
    Dividing by n makes the signature comparable across basins of different size.
    """
    import numpy as np

    n = len(basin_ids)
    if n == 0:
        return [0.0] * len(timescales)

    idx = {node: i for i, node in enumerate(basin_ids)}
    members = set(basin_ids)

    # Induced adjacency matrix (only edges with both endpoints inside the basin).
    A = np.zeros((n, n), dtype=np.float64)
    for node in basin_ids:
        for nbr in adj.get(node, ()):
            if nbr in members:
                A[idx[node], idx[nbr]] = 1.0

    deg = A.sum(axis=1)
    # No edges (isolated node(s)): the normalized Laplacian is all-zero, so every
    # eigenvalue is 0 and the normalized heat trace is exactly 1 at every scale.
    if n == 1 or deg.sum() == 0:
        return [1.0] * len(timescales)

    d_inv_sqrt = np.where(deg > 0, 1.0 / np.sqrt(deg), 0.0)
    L = np.eye(n) - (d_inv_sqrt[:, None] * A * d_inv_sqrt[None, :])
    # Symmetric → use eigvalsh; clip tiny negatives from floating-point error.
    eig = np.clip(np.linalg.eigvalsh(L), 0.0, None)

    return [float(np.exp(-t * eig).sum() / n) for t in timescales]


def _basin_nx_graph(basin_ids: list[int], adj: dict[int, set]):
    """Induced, undirected networkx graph of a basin (graph2vec input).

    Road-node ids are relabelled to consecutive integers 0..n-1 so the WL
    feature strings depend only on the *structure*, never on the absolute node
    ids (which would make otherwise-identical basins look different).
    """
    import networkx as nx

    members = set(basin_ids)
    idx = {node: i for i, node in enumerate(basin_ids)}
    g = nx.Graph()
    g.add_nodes_from(range(len(basin_ids)))
    for node in basin_ids:
        i = idx[node]
        for nbr in adj.get(node, ()):
            if nbr in members and i < idx[nbr]:
                g.add_edge(i, idx[nbr])
    return g


def _wl_features(graph, wl_iterations: int) -> list[str]:
    """
    Weisfeiler-Lehman subtree "words" for one graph — graph2vec's vocabulary.

    With no node attributes, each node starts labelled by its degree; at every
    WL round a node is relabelled to a hash of (its own label + its sorted
    neighbour labels), which encodes the rooted subtree of growing radius around
    it.  The multiset of all labels seen across rounds 0..k is the graph's
    "document"; structurally similar graphs share many of these subtree words.
    """
    import hashlib

    labels = {n: str(graph.degree(n)) for n in graph.nodes()}
    features: list[str] = list(labels.values())  # round 0 = degree labels
    for _ in range(wl_iterations):
        relabelled = {}
        for n in graph.nodes():
            neigh = sorted(labels[m] for m in graph.neighbors(n))
            token = labels[n] + "|" + "|".join(neigh)
            relabelled[n] = hashlib.md5(token.encode()).hexdigest()[:12]
        labels = relabelled
        features.extend(labels.values())
    return features


def _graph2vec_signatures(
    basin_ids_list, adj, dimensions: int = _GRAPH2VEC_DIMS, wl_iterations: int = 2
):
    """
    graph2vec whole-graph embedding of every basin's induced road sub-network.

    Self-contained implementation of graph2vec (Narayanan et al., 2017): each
    graph is turned into a document of Weisfeiler-Lehman subtree patterns
    (``_wl_features``) and the documents are embedded jointly with gensim's
    Doc2Vec (PV-DBOW, ``dm=0``) — exactly the recipe in the paper, without the
    karateclub package (whose pinned numpy/networkx have no Python-3.13 wheels
    and would clash with osmnx).  Fitting over the whole corpus means
    structurally recurring sub-networks get nearby vectors.

    Returns an (N, dimensions) array aligned with ``basin_ids_list``, or None
    when gensim is unavailable / the fit fails, so the caller can fall back to
    the NetLSD heat trace and the pipeline still produces an embedding.
    """
    try:
        from gensim.models.doc2vec import Doc2Vec, TaggedDocument
    except ImportError:
        print("  gensim not installed; using NetLSD heat trace "
              "(pip install gensim to enable graph2vec).")
        return None

    import numpy as np

    try:
        graphs = [_basin_nx_graph(b, adj) for b in basin_ids_list]
        documents = [
            TaggedDocument(words=_wl_features(g, wl_iterations), tags=[str(i)])
            for i, g in enumerate(graphs)
        ]
        model = Doc2Vec(
            documents,
            vector_size=dimensions,
            dm=0,            # PV-DBOW, as in the graph2vec paper
            min_count=1,     # keep rare subtree patterns; the corpus is small
            epochs=50,
            workers=1,       # single worker → reproducible with a fixed seed
            seed=42,
        )
        emb = np.array([model.dv[str(i)] for i in range(len(graphs))], dtype=np.float64)
        print(f"  graph2vec: {len(graphs)} basins -> {emb.shape[1]}-D signature "
              f"(WL-{wl_iterations} + Doc2Vec)")
        return emb
    except Exception as exc:
        print(f"  graph2vec failed ({exc}); using NetLSD heat trace.")
        return None


# ─── The 4 modern urban-subgraph embedding techniques ─────────────────────────
#
# Each function below turns every basin's induced road sub-network into one
# fixed-length descriptor; UMAP reduces it to 2-D for the front-end scatter.
# All are whole-graph embeddings (one vector per subgraph), permutation/size
# invariant, and implemented self-contained (numpy / networkx / gensim) — no
# `karateclub` (whose pinned deps have no Python-3.13 wheels and clash with osmnx).
#
#   1. GL2Vec   — Chen & Koga, "GL2vec: Graph Embedding Enriched by Line Graphs
#                 with Edge Features", ICONIP 2019.
#   2. FEATHER-G— Rozemberczki & Sarkar, "Characteristic Functions on Graphs:
#                 Birds of a Feather, from Statistical Descriptors to Parametric
#                 Models", CIKM 2020.
#   3. DHC-E    — Wang, Deng, Lü & Chen, "Hyperparameter-free and Explainable
#                 Whole Graph Embedding", 2022 (arXiv:2108.02113).
#   4. GCN      — graph convolution (Kipf & Welling, ICLR 2017), the spatial
#                 embedding used in the ST-GCN module of Fan, Hu & Hu,
#                 "Research on a Crime Spatiotemporal Prediction Method Integrating
#                 Informer and ST-GCN: A Case Study of Four Crime Types in
#                 Chicago", Big Data Cogn. Comput. 2025, 9(7), 179.

# Output dimensionality of the two Doc2Vec halves of GL2Vec (G ⊕ L(G)); the two
# 32-D halves concatenate to a 64-D signature, matching _GRAPH2VEC_DIMS.
_GL2VEC_HALF_DIMS = 32


def _gl2vec_signatures(
    basin_ids_list, adj, half_dims: int = _GL2VEC_HALF_DIMS, wl_iterations: int = 2
):
    """
    GL2Vec whole-graph embedding (Chen & Koga, ICONIP 2019).

    GL2Vec enriches graph2vec by *also* embedding the **line graph** L(G) — the
    graph whose nodes are the edges (road segments) of G, with two segments
    adjacent when they share an intersection.  The line graph exposes structure
    that lives on the edges (how road segments chain through junctions), which
    graph2vec — operating only on G's nodes — misses.  As in the paper, each
    basin's vector is the **concatenation** of the graph2vec embedding of G and
    the graph2vec embedding of L(G).

    Implementation notes
    --------------------
    • We embed G and L(G) with two independent Doc2Vec models (PV-DBOW), each on
      WL-subtree documents (``_wl_features``), then hstack the two halves — the
      paper's "concatenate the two embeddings" recipe.
    • We use the *structural* variant of the line graph (initial node label =
      degree), because hotspots.json stores only a per-basin road-class
      histogram, not a per-edge class label.  This is still faithful to GL2Vec
      (line graph + concatenation) and is what separates it from plain graph2vec.

    Returns an (N, 2*half_dims) array aligned with ``basin_ids_list``, or None if
    gensim is unavailable / the fit fails (caller falls back to NetLSD).
    """
    try:
        from gensim.models.doc2vec import Doc2Vec, TaggedDocument
    except ImportError:
        print("  gensim not installed; GL2Vec falls back to NetLSD heat trace.")
        return None

    import networkx as nx
    import numpy as np

    def _embed(graphs, prefix: str) -> "np.ndarray":
        docs = [
            TaggedDocument(words=[prefix + w for w in _wl_features(g, wl_iterations)],
                           tags=[str(i)])
            for i, g in enumerate(graphs)
        ]
        model = Doc2Vec(
            docs, vector_size=half_dims, dm=0, min_count=1, epochs=50,
            workers=1, seed=42,
        )
        return np.array([model.dv[str(i)] for i in range(len(graphs))], dtype=np.float64)

    try:
        graphs = [_basin_nx_graph(b, adj) for b in basin_ids_list]
        # Line graph of each basin; an empty/edgeless basin yields an empty L(G).
        line_graphs = [nx.line_graph(g) for g in graphs]

        g_emb = _embed(graphs, "g:")
        l_emb = _embed(line_graphs, "l:")
        emb = np.hstack([g_emb, l_emb])
        print(f"  GL2Vec: {len(graphs)} basins -> {emb.shape[1]}-D signature "
              f"(graph2vec(G) (+) graph2vec(L(G)))")
        return emb
    except Exception as exc:
        print(f"  GL2Vec failed ({exc}); using NetLSD heat trace.")
        return None


def _feather_signatures(
    basin_ids_list, adj, eval_points: int = 5, scales: int = 5
):
    """
    FEATHER-G whole-graph embedding (Rozemberczki & Sarkar, CIKM 2020).

    FEATHER describes the distribution of a node feature at multiple scales via
    its **characteristic function** evaluated over the transition probabilities
    of random walks.  For a node feature x and the random-walk transition matrix
    P = D⁻¹A, the order-r, point-θ descriptor of node u is

        Re:  Σ_v (P^r)_{uv} cos(θ·x_v)        Im:  Σ_v (P^r)_{uv} sin(θ·x_v)

    i.e. the real/imaginary parts of E[e^{iθx}] under the r-step walk from u.
    Pooling the node descriptors (here by mean) gives a compact, deterministic,
    isomorphism-invariant **graph** descriptor (FEATHER-G), as the paper derives
    when going "from statistical descriptors to parametric models".

    We use the node **degree** (min-max normalized within the basin) as the
    feature x, scales r = 1..``scales`` and ``eval_points`` evaluation points θ.
    Edgeless basins (no walks possible) fall back to the bare feature moments so
    every basin still gets a vector.  Returns an (N, D) numpy array.
    """
    import numpy as np

    thetas = np.linspace(0.5, 2.5, eval_points)
    # Per basin: 2 (Re/Im) · scales · eval_points pooled values.
    desc_dim = 2 * scales * eval_points
    out = np.zeros((len(basin_ids_list), desc_dim), dtype=np.float64)

    for bi, basin_ids in enumerate(basin_ids_list):
        n = len(basin_ids)
        if n == 0:
            continue

        idx = {node: i for i, node in enumerate(basin_ids)}
        members = set(basin_ids)
        A = np.zeros((n, n), dtype=np.float64)
        for node in basin_ids:
            for nbr in adj.get(node, ()):
                if nbr in members:
                    A[idx[node], idx[nbr]] = 1.0

        deg = A.sum(axis=1)
        # Node feature x = degree, min-max normalized within the basin to [0, 1].
        x = deg.copy()
        rng = x.max() - x.min()
        x = (x - x.min()) / rng if rng > 1e-9 else np.zeros_like(x)

        if deg.sum() == 0:
            # No edges → no random walk. Use the raw characteristic function of x
            # (the "0-step" walk: each node sees only itself) so the descriptor is
            # still defined and comparable in shape to the walked ones.
            feats = []
            for _ in range(scales):
                for th in thetas:
                    feats.append(float(np.cos(th * x).mean()))
                    feats.append(float(np.sin(th * x).mean()))
            out[bi] = feats
            continue

        d_inv = np.where(deg > 0, 1.0 / deg, 0.0)
        P = d_inv[:, None] * A  # row-stochastic transition matrix P = D⁻¹A

        feats = []
        Pr = np.eye(n)
        for _ in range(scales):
            Pr = Pr @ P  # P^r for r = 1..scales
            for th in thetas:
                re = (Pr @ np.cos(th * x))   # per-node real part
                im = (Pr @ np.sin(th * x))   # per-node imaginary part
                feats.append(float(re.mean()))  # mean-pool over nodes → graph level
                feats.append(float(im.mean()))
        out[bi] = feats

    print(f"  FEATHER-G: {len(basin_ids_list)} basins -> {desc_dim}-D signature "
          f"(characteristic functions over {scales}-step random walks)")
    return out


def _dhce_signatures(basin_ids_list, adj, length: int = 16):
    """
    DHC-E whole-graph embedding (Wang, Deng, Lü & Chen, 2022; arXiv:2108.02113).

    DHC-E is hyperparameter-free and explainable.  It iterates the **DHC operator**
    — by the DHC theorem the fixed point of repeatedly replacing every node's
    value with the *H-index* of its neighbours' values is the node's **coreness**,
    and the chain Degree → H-index → … → Coreness encodes multi-scale structure.
    At each iteration t we take the **Shannon entropy** E_t of the (normalized)
    histogram of node values; the embedding is the entropy sequence
    [E_0, E_1, …], padded/truncated to a fixed ``length`` so all basins align.

    H-index of a multiset S = the largest h such that at least h elements of S are
    ≥ h.  Returns an (N, length) numpy array.
    """
    import numpy as np

    def _h_index(values) -> int:
        s = sorted(values, reverse=True)
        h = 0
        for i, v in enumerate(s, start=1):
            if v >= i:
                h = i
            else:
                break
        return h

    def _entropy(values) -> float:
        # Shannon entropy of the empirical distribution of the integer values,
        # normalized to [0, 1] by log(#distinct) so basins of different size are
        # comparable.
        vals, counts = np.unique(np.asarray(values), return_counts=True)
        if len(vals) <= 1:
            return 0.0
        p = counts / counts.sum()
        ent = float(-(p * np.log(p)).sum())
        return ent / math.log(len(vals))

    out = np.zeros((len(basin_ids_list), length), dtype=np.float64)

    for bi, basin_ids in enumerate(basin_ids_list):
        n = len(basin_ids)
        if n == 0:
            continue

        members = set(basin_ids)
        neighbours = {
            node: [nb for nb in adj.get(node, ()) if nb in members]
            for node in basin_ids
        }
        # Iteration 0: degree.
        value = {node: len(neighbours[node]) for node in basin_ids}

        seq = [_entropy(list(value.values()))]
        for _ in range(length - 1):
            nxt = {
                node: _h_index([value[nb] for nb in neighbours[node]])
                for node in basin_ids
            }
            seq.append(_entropy(list(nxt.values())))
            if nxt == value:        # reached the coreness fixed point
                break
            value = nxt

        # Pad the converged tail with its last entropy so every row has `length`.
        seq = (seq + [seq[-1]] * length)[:length]
        out[bi] = seq

    print(f"  DHC-E: {len(basin_ids_list)} basins -> {length}-D signature "
          f"(entropy of the Degree -> H-index -> Coreness chain)")
    return out


# GCN hidden width and depth. 2 layers = 2-hop receptive field, matching the
# small basins here; 16 hidden units is ample for graphs of 1-63 nodes.
_GCN_HIDDEN = 16
_GCN_LAYERS = 2


def _gcn_signatures(basin_ids_list, adj, hidden: int = _GCN_HIDDEN, layers: int = _GCN_LAYERS):
    """
    GCN spatial embedding — graph convolution of Kipf & Welling (ICLR 2017),
    the spatial-feature extractor used in the ST-GCN module of Fan, Hu & Hu
    (Big Data Cogn. Comput. 2025, 9(7), 179) for Chicago crime prediction.

    Each GCN layer is the paper's Eq. (7):

        H' = ReLU( D̃^{-1/2} (A + I) D̃^{-1/2} · H · W )

    i.e. every node mixes its neighbours' features through the symmetric-
    normalized adjacency (with self-loops), then a linear map + ReLU.  Stacking
    `layers` of these gives each node a `layers`-hop structural embedding; we
    **mean-pool** the node embeddings into one whole-graph descriptor per basin.

    Unsupervised use
    ----------------
    The paper trains the GCN against crime counts, but here crime must NOT shape
    the layout (it is the outcome we want to read off the map).  So we run an
    **untrained GCN with fixed random weights** (seed=42) — a standard structural
    feature extractor: the informative part is the normalized-adjacency diffusion
    of the node features, not the learned weights.  Node features are structure-
    only: [1, degree, log1p(degree)].

    Returns an (N, hidden) numpy array aligned with `basin_ids_list`.
    """
    import numpy as np

    rng = np.random.default_rng(42)
    in_dim = 3  # node features: [1, degree, log1p(degree)]
    # Fixed random layer weights (Xavier-like scaling), shared across all basins.
    weights = []
    d_prev = in_dim
    for _ in range(layers):
        weights.append(rng.standard_normal((d_prev, hidden)) / math.sqrt(d_prev))
        d_prev = hidden

    out = np.zeros((len(basin_ids_list), hidden), dtype=np.float64)

    for bi, basin_ids in enumerate(basin_ids_list):
        n = len(basin_ids)
        if n == 0:
            continue

        idx = {node: i for i, node in enumerate(basin_ids)}
        members = set(basin_ids)
        A = np.zeros((n, n), dtype=np.float64)
        for node in basin_ids:
            for nbr in adj.get(node, ()):
                if nbr in members:
                    A[idx[node], idx[nbr]] = 1.0

        # Symmetric-normalized adjacency with self-loops: Â = D̃^{-1/2}(A+I)D̃^{-1/2}.
        A_hat = A + np.eye(n)
        deg = A_hat.sum(axis=1)
        d_inv_sqrt = 1.0 / np.sqrt(deg)
        A_norm = d_inv_sqrt[:, None] * A_hat * d_inv_sqrt[None, :]

        deg_in = A.sum(axis=1)  # within-basin degree (excludes the self-loop)
        H = np.column_stack([np.ones(n), deg_in, np.log1p(deg_in)])
        for W in weights:
            H = np.maximum(A_norm @ H @ W, 0.0)  # GCN layer + ReLU

        out[bi] = H.mean(axis=0)  # mean-pool node embeddings -> graph descriptor

    print(f"  GCN: {len(basin_ids_list)} basins -> {hidden}-D signature "
          f"({layers}-layer Kipf-Welling GCN + mean-pool, untrained)")
    return out


def _topology_block(spot: dict, signature) -> list[float]:
    """Topology signature (graph2vec or NetLSD) + structural stats + metric geometry."""
    node_count = len(spot["nodes"])
    edge_count = len(spot["edges"])
    max_possible = node_count * (node_count - 1) / 2
    density = edge_count / max_possible if max_possible > 0 else 0.0
    mean_deg = (2 * edge_count / node_count) if node_count > 0 else 0.0

    # The learned/spectral signature is blind to absolute scale and to metricHDB SCAM
    # geometry, so we append a single explicit scale feature (log-size) with
    # density / mean-degree, plus the geometry features — inter-node distances
    # and shape (a tight straight chain vs. a spread-out L look the same to the
    # signature, but differ here).
    return list(signature) + [math.log1p(node_count), density, mean_deg] + _geometry_features(spot)


def _history_block(basin_ids, month, node_month_counts, months) -> list[float]:
    """
    Temporal profile of the basin footprint over the whole study window.

    Counts crimes inside the footprint for every month, then summarises:
      z      – std-scores of the current month vs the footprint's own history
               (how unusual *this* month is for *this* place),
      cv     – coefficient of variation (volatility),
      slope  – normalized linear trend across months (growing / shrinking),
      recur  – fraction of months the footprint was active (persistence),
      level  – log mean monthly intensity (baseline severity).
    """
    import numpy as np

    series = np.array(
        [sum(node_month_counts.get(n, {}).get(m, 0) for n in basin_ids) for m in months],
        dtype=np.float64,
    )
    mu = float(series.mean())
    sd = float(series.std())
    cur = float(series[months.index(month)])

    z = (cur - mu) / sd if sd > 0 else 0.0
    cv = sd / mu if mu > 0 else 0.0
    if len(series) > 1 and mu > 0:
        slope = float(np.polyfit(np.arange(len(series)), series, 1)[0]) / mu
    else:
        slope = 0.0
    recur = float((series > 0).mean())
    level = math.log1p(mu)

    return [z, cv, slope, recur, level]


def _poi_block(spot) -> list[float]:
    """Land-use fingerprint: normalized POI-category distribution + density + entropy."""
    counts = spot.get("poiTypes", {}) or {}
    total = sum(counts.values())

    dist = [counts.get(c, 0) / total if total > 0 else 0.0 for c in POI_CATEGORIES]

    n_nodes = max(len(spot["nodes"]), 1)
    density = math.log1p(total / n_nodes)

    entropy = 0.0
    if total > 0:
        for c in POI_CATEGORIES:
            p = counts.get(c, 0) / total
            if p > 0:
                entropy -= p * math.log(p)
        if len(POI_CATEGORIES) > 1:
            entropy /= math.log(len(POI_CATEGORIES))  # normalize to [0, 1]

    return dist + [density, entropy]


def _road_block(spot) -> list[float]:
    """
    Road-hierarchy fingerprint of the basin: the normalized distribution of its
    edges over ROAD_CLASSES (expressway / avenue / collector / street / …) plus
    the share of the dominant class.  This is what tells the embedding whether a
    basin is "made of avenues" or "made of residential streets", so two basins
    with identical shape but different street types separate in the UMAP.
    """
    counts = spot.get("roadTypes", {}) or {}
    total = sum(counts.values())
    dist = [counts.get(c, 0) / total if total > 0 else 0.0 for c in ROAD_CLASSES]
    dominant = max(dist) if total > 0 else 0.0
    return dist + [dominant]


def _crime_block(spot) -> list[float]:
    """Normalized distribution over crime types (semantic composition)."""
    counts = spot.get("crimeTypes", {}) or {}
    total = sum(counts.values())
    return [counts.get(c, 0) / total if total > 0 else 0.0 for c in CRIME_TYPES]


def _standardize(block):
    """Column-wise z-score; constant columns are zeroed (no information)."""
    import numpy as np
    mu = block.mean(axis=0)
    sd = block.std(axis=0)
    sd = np.where(sd > 1e-9, sd, 1.0)
    out = (block - mu) / sd
    out[:, block.std(axis=0) <= 1e-9] = 0.0
    return out


# HDBSCAN parameters for clustering each UMAP layout. With ~480 points,
# min_cluster_size=8 keeps clusters meaningful while min_samples=4 (< size)
# keeps the noise set from swallowing too many points.
_HDBSCAN_MIN_CLUSTER_SIZE = 8
_HDBSCAN_MIN_SAMPLES = 4


def _hdbscan_labels(coords, min_cluster_size: int = _HDBSCAN_MIN_CLUSTER_SIZE,
                    min_samples: int = _HDBSCAN_MIN_SAMPLES) -> list[int]:
    """
    Density-based clustering (HDBSCAN) of a 2-D point cloud.

    Runs directly on the UMAP layout of one embedding technique, so the painted
    clusters match exactly what the analyst sees on that scatter.  Returns one
    integer label per point (-1 = noise, HDBSCAN's convention).  Prefers
    scikit-learn's HDBSCAN (>=1.3); falls back to the standalone `hdbscan`
    package, and finally to all-noise so the pipeline never breaks.
    """
    import numpy as np

    pts = np.asarray(coords, dtype=np.float64)
    n = len(pts)
    if n < min_cluster_size:
        return [-1] * n

    try:
        from sklearn.cluster import HDBSCAN
        labels = HDBSCAN(min_cluster_size=min_cluster_size,
                         min_samples=min_samples).fit_predict(pts)
    except Exception:
        try:
            import hdbscan
            labels = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size,
                                     min_samples=min_samples).fit_predict(pts)
        except Exception as exc:
            print(f"  HDBSCAN unavailable ({exc}); points left unclustered.")
            return [-1] * n

    return [int(x) for x in labels]


def compute_subgraph_embeddings(
    output: dict,
    adj: dict[int, set],
    node_month_counts: dict[int, dict[str, int]],
    months: list[str],
) -> None:
    """
    Build the per-block descriptors for every subgraph and project each
    embedding *variant* (see _EMBED_VARIANTS) to 2-D.

    Adds, in place, to each hotspot:
      embedGL2Vec – [x, y] from GL2Vec  (graph2vec(G) ⊕ graph2vec(L(G)))
      embedFeather– [x, y] from FEATHER-G (characteristic functions / random walks)
      embedDHCE   – [x, y] from DHC-E   (Degree→H-index→Coreness entropy chain)
      embedGCN    – [x, y] from a GCN   (Kipf-Welling graph conv + mean-pool;
                                         the ST-GCN spatial module of Fan et al. 2025)
      embedTopo   – [x, y] from topology only (graph2vec / NetLSD + geometry)  [legacy]
      embed2d     – [x, y] from topology + road class                          [legacy]
      history – monthly crime counts at the basin's footprint, aligned with
                the sorted `months` list (raw series for the front-end chart;
                it no longer feeds the embedding coordinates).

    The four modern techniques (GL2Vec / FEATHER-G / DHC-E / GCN) are the spaces
    the front-end UMAP exposes; the legacy topo / topoRoad variants are still
    emitted for parity but are no longer shown.

    Expects a temporary `_basinIds` field on each spot (stripped by the caller),
    and a `roadTypes` edge-class histogram (written by the main pipeline).
    """
    import numpy as np

    keys: list[tuple[str, int]] = []
    basin_ids_list: list[list[int]] = []
    road = []

    for month, spots in output.items():
        for spot in spots:
            basin_ids = spot.get("_basinIds", [])
            keys.append((month, spot["rank"]))
            basin_ids_list.append(basin_ids)
            road.append(_road_block(spot))
            # Raw monthly series at this footprint (for the front-end chart).
            spot["history"] = [
                int(sum(node_month_counts.get(n, {}).get(m, 0) for n in basin_ids))
                for m in months
            ]

    # All 2-D fields written by this function (legacy variants + 4 techniques).
    all_fields = list(_EMBED_FIELD.values()) + [
        "embedGL2Vec", "embedFeather", "embedDHCE", "embedGCN",
    ]

    # Cluster-label fields (one per technique; −1 = noise, HDBSCAN convention).
    cluster_fields = ["clusterGL2Vec", "clusterFeather", "clusterDHCE", "clusterGCN"]

    if len(keys) < 2:
        for spots in output.values():
            for spot in spots:
                for field in all_fields:
                    spot[field] = [0.5, 0.5]
                for field in cluster_fields:
                    spot[field] = -1
        return

    # Topology signature per basin: graph2vec when gensim is available, else a
    # NetLSD heat-kernel trace, so the layout survives a missing optional dep.
    signatures = _graph2vec_signatures(basin_ids_list, adj)
    if signatures is None:
        timescales = _heat_timescales()
        signatures = np.array(
            [_heat_trace_signature(b, adj, timescales) for b in basin_ids_list],
            dtype=np.float64,
        )

    # Assemble the topology block (signature + structural stats + geometry) in
    # the same order as `keys`, so it stays row-aligned with the road block.
    spots_in_order = [spot for spots in output.values() for spot in spots]
    topo = [_topology_block(spot, signatures[i]) for i, spot in enumerate(spots_in_order)]

    # Standardize each block independently, weight it, then concatenate.  This
    # keeps the high-dimensional topology block from being drowned out by the
    # smaller road-class block purely because of differing dimensionality / scale.
    blocks = {
        "topo": _standardize(np.array(topo, dtype=np.float64)),
        "road": _standardize(np.array(road, dtype=np.float64)),
    }

    key_to_idx = {k: i for i, k in enumerate(keys)}

    def _project(X: "np.ndarray") -> tuple["np.ndarray", str]:
        # UMAP preserves local neighbourhood structure, which is what makes the
        # scatter readable as "clusters of similar subgraphs".
        try:
            import umap  # umap-learn

            reducer = umap.UMAP(
                n_neighbors=15,
                min_dist=0.1,
                metric="cosine",
                random_state=42,
            )
            return reducer.fit_transform(X), "UMAP"
        except Exception as exc:  # umap-learn missing or failed → PCA fallback
            print(f"  UMAP unavailable ({exc}); falling back to PCA(2).")
            Xc = X - X.mean(axis=0)
            _, _, Vt = np.linalg.svd(Xc, full_matrices=False)
            return Xc @ Vt[:2].T, "PCA"

    def _project_and_write(name: str, X: "np.ndarray", field: str,
                           cluster_field: str | None = None) -> None:
        """Project a descriptor to 2-D, min-max scale, write `field`, and —
        when `cluster_field` is given — HDBSCAN-cluster the 2-D layout and write
        the integer cluster label (−1 = noise) of each subgraph to it."""
        emb, method = _project(X)

        # Min-max scale each axis to [0, 1] so the front-end can plot without
        # knowing the raw coordinate ranges.
        emb = np.asarray(emb, dtype=np.float64)
        lo = emb.min(axis=0)
        rng = np.where(emb.max(axis=0) > lo, emb.max(axis=0) - lo, 1.0)
        emb = (emb - lo) / rng

        # Cluster the (scaled) 2-D layout so the painted clusters match the plot.
        labels = _hdbscan_labels(emb) if cluster_field else None

        for month, spots in output.items():
            for spot in spots:
                i = key_to_idx[(month, spot["rank"])]
                spot[field] = [round(float(emb[i, 0]), 4), round(float(emb[i, 1]), 4)]
                if labels is not None:
                    spot[cluster_field] = labels[i]

        msg = (f"  {method} '{name}' embedding for {len(keys)} subgraphs "
               f"({X.shape[1]}-D descriptor -> 2-D -> {field})")
        if labels is not None:
            n_clusters = len({l for l in labels if l >= 0})
            n_noise = sum(1 for l in labels if l < 0)
            msg += f"; HDBSCAN -> {n_clusters} clusters, {n_noise} noise -> {cluster_field}"
        print(msg)

    # Legacy variants (topo / topoRoad) — still emitted for parity.
    for variant, block_names in _EMBED_VARIANTS.items():
        X = np.hstack([blocks[name] * _EMBED_WEIGHTS[name] for name in block_names])
        _project_and_write(variant, X, _EMBED_FIELD[variant])

    # ── The 3 modern techniques shown on the page ────────────────────────────
    # Each produces its own high-D descriptor over the basins' road sub-networks;
    # we standardize it and project to 2-D exactly like the legacy variants, so
    # all spaces are directly comparable on the scatter.

    # 1. GL2Vec — graph2vec(G) ⊕ graph2vec(L(G)); NetLSD fallback if gensim absent.
    gl2vec = _gl2vec_signatures(basin_ids_list, adj)
    if gl2vec is None:
        timescales = _heat_timescales()
        gl2vec = np.array(
            [_heat_trace_signature(b, adj, timescales) for b in basin_ids_list],
            dtype=np.float64,
        )
    _project_and_write("GL2Vec", _standardize(np.asarray(gl2vec, dtype=np.float64)),
                       "embedGL2Vec", "clusterGL2Vec")

    # 2. FEATHER-G — characteristic functions over random walks (deterministic).
    feather = _feather_signatures(basin_ids_list, adj)
    _project_and_write("FEATHER-G", _standardize(np.asarray(feather, dtype=np.float64)),
                       "embedFeather", "clusterFeather")

    # 3. DHC-E — entropy of the Degree→H-index→Coreness chain (hyperparameter-free).
    dhce = _dhce_signatures(basin_ids_list, adj)
    _project_and_write("DHC-E", _standardize(np.asarray(dhce, dtype=np.float64)),
                       "embedDHCE", "clusterDHCE")

    # 4. GCN — Kipf-Welling graph convolution + mean-pool; the ST-GCN spatial
    #    embedding of Fan, Hu & Hu (2025). Untrained (crime must not shape layout).
    gcn = _gcn_signatures(basin_ids_list, adj)
    _project_and_write("GCN", _standardize(np.asarray(gcn, dtype=np.float64)),
                       "embedGCN", "clusterGCN")


# ─── POI fetching & assignment ────────────────────────────────────────────────

def fetch_pois_chicago() -> list[dict]:
    """Download Chicago POIs from Overpass via OSMnx."""
    print("  Fetching POIs from Overpass API (may take ~30 s)…")
    try:
        gdf = ox.features_from_place("Chicago, Illinois, USA", tags=_POI_TAGS)
    except Exception as exc:
        print(f"  WARNING: POI fetch failed ({exc}). Hotspots will have empty poiTypes.")
        return []

    pois: list[dict] = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None:
            continue
        if geom.geom_type == "Point":
            lat, lng = geom.y, geom.x
        else:
            c = geom.centroid
            lat, lng = c.y, c.x

        cat = "other"
        for col in ("amenity", "shop", "leisure"):
            val = row.get(col)
            if val and isinstance(val, str) and val in _POI_CATEGORY:
                cat = _POI_CATEGORY[val]
                break

        pois.append({"lat": round(lat, 6), "lng": round(lng, 6), "category": cat})

    print(f"  Fetched {len(pois):,} POIs")
    return pois


def assign_pois_to_hotspots(output: dict, pois: list[dict]) -> None:
    """Spatially join POIs to each hotspot subgraph via convex-hull containment."""
    from shapely.geometry import MultiPoint, Point
    from shapely.strtree import STRtree

    for spots in output.values():
        for spot in spots:
            spot["pois"] = []
            spot["poiTypes"] = {}

    if not pois:
        return

    poi_geoms = [Point(p["lng"], p["lat"]) for p in pois]
    tree = STRtree(poi_geoms)

    for spots in output.values():
        for spot in spots:
            nodes = spot["nodes"]
            if not nodes:
                continue

            center = spot["center"]
            if len(nodes) < 3:
                if not center:
                    continue
                hull = Point(center[1], center[0]).buffer(0.003)
            else:
                mp = MultiPoint([(n[1], n[0]) for n in nodes])
                hull = mp.convex_hull.buffer(0.001)

            indices = tree.query(hull, predicate="contains")
            spot_pois = [
                {"lat": pois[i]["lat"], "lng": pois[i]["lng"], "category": pois[i]["category"]}
                for i in indices
            ]
            spot["pois"] = spot_pois

            counts: dict[str, int] = {}
            for p in spot_pois:
                counts[p["category"]] = counts.get(p["category"], 0) + 1
            spot["poiTypes"] = counts

    total_assigned = sum(len(s["pois"]) for spots in output.values() for s in spots)
    print(f"  Assigned {total_assigned:,} POI occurrences across all hotspots")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    # 1. Load crimes
    csv_path = "public/crimes.csv"
    print(f"Loading {csv_path} …")
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=["lat", "lng", "date"])
    df["date_parsed"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date_parsed"])
    df["month"] = df["date_parsed"].dt.to_period("M").astype(str)

    if "type" not in df.columns:
        df["type"] = "UNKNOWN"
    else:
        df["type"] = df["type"].fillna("UNKNOWN").astype(str)

    print(f"  {len(df):,} crimes · {df['month'].nunique()} months")

    # 2. Download Chicago drive network (cached by osmnx after first run)
    print("\nDownloading Chicago road network (drive, simplified) …")
    ox.settings.log_console = False
    G = ox.graph_from_place(
        "Chicago, Illinois, USA",
        network_type="drive",
        simplify=True,
    )
    print(f"  {len(G.nodes):,} nodes · {len(G.edges):,} edges")

    # 3. Build adjacency list, node coordinates, and per-edge road class.
    adj: dict[int, set[int]] = defaultdict(set)
    edge_road: dict[tuple[int, int], str] = {}
    for u, v, data in G.edges(keys=False, data=True):
        adj[u].add(v)
        adj[v].add(u)
        key = (u, v) if u <= v else (v, u)
        cls = _road_class(data.get("highway"))
        # If parallel edges disagree, keep the more major class (lower index).
        prev = edge_road.get(key)
        if prev is None or ROAD_CLASSES.index(cls) < ROAD_CLASSES.index(prev):
            edge_road[key] = cls

    node_latlng: dict[int, tuple[float, float]] = {
        n: (float(d["y"]), float(d["x"])) for n, d in G.nodes(data=True)
    }

    # 4. Snap crimes: nearest road edge → nearest endpoint node
    print("\nSnapping crimes to nearest road nodes (edge first, then node) …")
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

    # 4b. Per-node monthly crime counts — the raw material for the historical
    #     block of the embedding (crimes at a node, broken down by month).
    node_month_counts: dict[int, dict[str, int]] = defaultdict(dict)
    for (node, m), cnt in df.groupby(["node", "month"]).size().items():
        node_month_counts[int(node)][m] = int(cnt)

    # 5. Per-month hotspot computation
    print("\nComputing hotspots per month …")
    months = sorted(df["month"].unique())
    output: dict[str, list] = {}

    for month in months:
        mdf = df[df["month"] == month]
        node_crimes: dict[int, int] = mdf["node"].value_counts().to_dict()

        hotspots = compute_hotspots(node_crimes, adj, top_k=20, max_hops=3, bridge=1)

        month_out: list[dict] = []
        for rank_idx, hs in enumerate(hotspots):
            basin_set: set[int] = hs["basin"]
            seed_node: int = hs["seed"]

            # Crime type breakdown
            basin_crimes = mdf[mdf["node"].isin(basin_set)]
            crime_types: dict[str, int] = basin_crimes["type"].value_counts().to_dict()

            # Edges within the basin subgraph, plus the road-class histogram of
            # those edges (the road-hierarchy fingerprint for the embedding).
            basin_edges: list = []
            road_types: dict[str, int] = {}
            seen_edges: set[tuple[int, int]] = set()
            for n in basin_set:
                for nbr in adj.get(n, set()):
                    if nbr not in basin_set:
                        continue
                    ekey = (min(n, nbr), max(n, nbr))
                    if ekey in seen_edges:
                        continue
                    seen_edges.add(ekey)
                    if n in node_latlng and nbr in node_latlng:
                        la, lo = node_latlng[n]
                        lb, lob = node_latlng[nbr]
                        basin_edges.append(
                            [[round(la, 6), round(lo, 6)],
                             [round(lb, 6), round(lob, 6)]]
                        )
                        cls = edge_road.get(ekey, "other")
                        road_types[cls] = road_types.get(cls, 0) + 1

            # Node positions for rendering
            basin_nodes: list = []
            for n in basin_set:
                if n in node_latlng:
                    lat_n, lng_n = node_latlng[n]
                    basin_nodes.append([round(lat_n, 6), round(lng_n, 6)])

            # Center = seed (peak crime) node
            center = None
            if seed_node in node_latlng:
                lc, lonc = node_latlng[seed_node]
                center = [round(lc, 6), round(lonc, 6)]

            month_out.append(
                dict(
                    rank=rank_idx + 1,
                    crimes=hs["total_crimes"],
                    peakCrimes=hs["peak_crimes"],
                    center=center,
                    nodes=basin_nodes,
                    edges=basin_edges,
                    crimeTypes=crime_types,
                    roadTypes=road_types,
                    # Temporary: node IDs of the basin, needed by the embedding
                    # step (topology + historical footprint). Stripped before
                    # the JSON is written so it never reaches the client.
                    _basinIds=list(basin_set),
                )
            )

        output[month] = month_out
        covered = sum(h["crimes"] for h in month_out)
        print(f"  {month}: {len(month_out)} hotspots · {covered:,} crimes in subgraphs")

    # 6. Topological similarity across all months
    print("\nComputing topological similarity …")
    compute_all_similarities(output, top_k=5)

    # 7. Fetch and assign POIs
    print("\nFetching POIs and assigning to hotspots …")
    pois = fetch_pois_chicago()
    assign_pois_to_hotspots(output, pois)

    # 8. Subgraph embedding (topology + history + POIs + crime mix) → 2-D UMAP.
    #    Runs after POI assignment so the POI block can read each spot's poiTypes.
    print("\nComputing subgraph embeddings (UMAP) …")
    compute_subgraph_embeddings(output, adj, node_month_counts, months)

    # 9. Drop temporary fields, then write output
    for spots in output.values():
        for spot in spots:
            spot.pop("_basinIds", None)

    out_path = "public/hotspots.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(output, fh, separators=(",", ":"))

    kb = os.path.getsize(out_path) / 1024
    print(f"\nWrote {out_path}  ({kb:.0f} KB)")


if __name__ == "__main__":
    main()
