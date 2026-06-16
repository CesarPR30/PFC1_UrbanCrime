import React, { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { FlyToInterpolator } from "@deck.gl/core";
import type { PickingInfo } from "@deck.gl/core";
import Map, { type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip } from "recharts";
import type { CrimeRecord } from "../hooks/useCrimeData";
import { useHotspots } from "../hooks/useHotspots";
import type { PoiEntry, Hotspot } from "../hooks/useHotspots";
import { useNodes } from "../hooks/useNodes";
import { useHotspotStore } from "../store/useHotspotStore";
import {
  crimeColor, crimeLabel, poiColor, poiLabel, hotspotColor, POI_RGB,
} from "../theme";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

const DEFAULT_VIEW_STATE = {
  longitude: -87.6298,
  latitude: 41.8781,
  zoom: 11,
  pitch: 0,
  bearing: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function monthKeysInRange(from: string, to: string): string[] {
  if (!from || !to) return [];
  let cur = new Date(`${from}T00:00:00`);
  cur = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const end = new Date(`${to}T00:00:00`);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  const keys: string[] = [];
  while (cur <= endMonth) {
    keys.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`
    );
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return keys;
}

// Sequential low→high ramp for the node crime map (same palette as the heatmap
// so the two views read consistently).
const NODE_RAMP: [number, number, number][] = [
  [255, 237, 160], [254, 217, 118], [254, 178, 76],
  [253, 141, 60], [240, 59, 32], [189, 0, 38],
];
function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (NODE_RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = NODE_RAMP[i];
  const b = NODE_RAMP[Math.min(i + 1, NODE_RAMP.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface EdgeDatum {
  src: [number, number];
  dst: [number, number];
  rank: number;
  month: string;
}

interface NodeDatum {
  pos: [number, number];
  rank: number;
  month: string;
}

/** A road node rendered in the node crime map (count = crimes within the date range). */
interface RenderNode {
  lat: number;
  lng: number;
  count: number;
  total: number;
}

interface Props {
  data: CrimeRecord[];
}

// ─── Component ────────────────────────────────────────────────────────────────

const CrimeMap: React.FC<Props> = ({ data }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapRef>(null);

  const [showPoints, setShowPoints] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showHotspots, setShowHotspots] = useState(false);
  const [showPois, setShowPois] = useState(false);
  const [showNodes, setShowNodes] = useState(false);
  // Selected node in the node crime map, keyed by "lat,lng".
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [viewState, setViewState] = useState<any>(DEFAULT_VIEW_STATE);

  const { selectedItem, setSelectedItem, flyTarget, triggerFlyTo, lassoSelection } =
    useHotspotStore();
  const { data: hotspotsData, available: hotspotsAvailable } = useHotspots();
  const { data: nodesData, available: nodesAvailable } = useNodes();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { mapRef.current?.resize(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!data.length) return;
    const sorted = data.map((d) => d.date).sort();
    setDateFrom(sorted[0]);
    setDateTo(sorted[sorted.length - 1]);
  }, [data]);

  // Fly-to: triggered from store (sidebar clicks or map clicks)
  useEffect(() => {
    if (!flyTarget) return;
    setViewState({
      longitude: flyTarget.lng,
      latitude: flyTarget.lat,
      zoom: 14.5,
      pitch: 0,
      bearing: 0,
      transitionDuration: 700,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.5 }),
    });
  }, [flyTarget]);

  const filtered = data.filter((d) => {
    if (dateFrom && d.date < dateFrom) return false;
    if (dateTo && d.date > dateTo) return false;
    return true;
  });

  const { hotspotEdges, hotspotNodes } = useMemo(() => {
    const edges: EdgeDatum[] = [];
    const nodes: NodeDatum[] = [];
    if (!hotspotsData) return { hotspotEdges: edges, hotspotNodes: nodes };

    const pushSpot = (spot: Hotspot, month: string) => {
      for (const [[lat1, lng1], [lat2, lng2]] of spot.edges) {
        edges.push({ src: [lng1, lat1], dst: [lng2, lat2], rank: spot.rank, month });
      }
      for (const [lat, lng] of spot.nodes) {
        nodes.push({ pos: [lng, lat], rank: spot.rank, month });
      }
    };
    const findSpot = (month: string, rank: number) =>
      hotspotsData[month]?.find((s) => s.rank === rank) ?? null;

    // Selection: show ONLY the selected subgraph and the ones similar to it,
    // regardless of the date filter (similars may live in other months).
    if (selectedItem) {
      const sel = findSpot(selectedItem.month, selectedItem.rank);
      if (sel) {
        pushSpot(sel, selectedItem.month);
        for (const sim of sel.similarTo ?? []) {
          const s = findSpot(sim.month, sim.rank);
          if (s) pushSpot(s, sim.month);
        }
      }
      return { hotspotEdges: edges, hotspotNodes: nodes };
    }

    // Lasso: show only the lassoed subgraphs.
    if (lassoSelection.length > 0) {
      for (const it of lassoSelection) {
        const s = findSpot(it.month, it.rank);
        if (s) pushSpot(s, it.month);
      }
      return { hotspotEdges: edges, hotspotNodes: nodes };
    }

    // Default: every top-20 subgraph within the visible date range.
    if (!showHotspots) return { hotspotEdges: edges, hotspotNodes: nodes };
    const months = monthKeysInRange(dateFrom, dateTo);
    for (const month of months) {
      const spots = hotspotsData[month];
      if (!spots) continue;
      for (const spot of spots) pushSpot(spot, month);
    }
    return { hotspotEdges: edges, hotspotNodes: nodes };
  }, [hotspotsData, showHotspots, dateFrom, dateTo, selectedItem, lassoSelection]);

  // All POIs from visible months, deduplicated by lat+lng
  const allHotspotPois = useMemo(() => {
    if (!hotspotsData || !showHotspots || !showPois) return [] as PoiEntry[];
    const months = monthKeysInRange(dateFrom, dateTo);
    const seen = new Set<string>();
    const result: PoiEntry[] = [];
    for (const month of months) {
      const spots = hotspotsData[month];
      if (!spots) continue;
      for (const spot of spots) {
        for (const poi of spot.pois ?? []) {
          const key = `${poi.lat},${poi.lng}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push(poi);
          }
        }
      }
    }
    return result;
  }, [hotspotsData, showHotspots, showPois, dateFrom, dateTo]);

  const selectedHotspot = useMemo(() => {
    if (!selectedItem || !hotspotsData) return null;
    return hotspotsData[selectedItem.month]?.find((s) => s.rank === selectedItem.rank) ?? null;
  }, [selectedItem, hotspotsData]);

  // Set of "month|rank" keys for similar hotspots – O(1) lookup in color fn
  const similarKeys = useMemo(() => {
    if (!selectedHotspot?.similarTo?.length) return new Set<string>();
    return new Set(selectedHotspot.similarTo.map((s) => `${s.month}|${s.rank}`));
  }, [selectedHotspot]);

  // Set of "month|rank" keys selected with the UMAP lasso tool.
  const lassoKeys = useMemo(
    () => new Set(lassoSelection.map((s) => `${s.month}|${s.rank}`)),
    [lassoSelection],
  );
  const hasLasso = lassoKeys.size > 0;

  // ─── Node crime map ───────────────────────────────────────────────────────
  // Per-node crime counts within the current date range, plus the busiest
  // count so colour can be expressed *relative to the highest-crime node*.
  // If the date range covers the whole window we use the precomputed total;
  // otherwise we sum the in-range months so the view tracks the date filter
  // exactly like the heat-map does.
  const { nodeRender, nodeMax } = useMemo(() => {
    if (!nodesData || !showNodes) {
      return { nodeRender: [] as RenderNode[], nodeMax: 1 };
    }
    const months = monthKeysInRange(dateFrom, dateTo);
    const monthSet = new Set(months);
    const full = months.length === 0 || nodesData.months.every((m) => monthSet.has(m));

    const out: RenderNode[] = [];
    let mx = 1;
    for (const nd of nodesData.nodes) {
      let count = nd.n;
      if (!full) {
        count = 0;
        for (const m of months) count += nd.m[m] ?? 0;
      }
      if (count <= 0) continue;
      out.push({ lat: nd.lat, lng: nd.lng, count, total: nd.n });
      if (count > mx) mx = count;
    }
    // Busiest nodes last so they paint on top of fainter neighbours.
    out.sort((a, b) => a.count - b.count);
    return { nodeRender: out, nodeMax: mx };
  }, [nodesData, showNodes, dateFrom, dateTo]);

  // Plain object, not a Map: `Map` is shadowed here by the react-map-gl import.
  const nodeByKey = useMemo(() => {
    const m: Record<string, RenderNode> = {};
    for (const r of nodeRender) m[`${r.lat},${r.lng}`] = r;
    return m;
  }, [nodeRender]);

  const selectedNode = selectedNodeKey ? nodeByKey[selectedNodeKey] ?? null : null;

  // Set of "lat,lng" keys for the selected hotspot's POIs – for highlight
  const selectedPoiKeys = useMemo(() => {
    if (!selectedHotspot?.pois?.length) return new Set<string>();
    return new Set(selectedHotspot.pois.map((p) => `${p.lat},${p.lng}`));
  }, [selectedHotspot]);

  const pieData = useMemo(() => {
    if (!selectedHotspot) return [];
    return Object.entries(selectedHotspot.crimeTypes)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [selectedHotspot]);

  // Full crime-type breakdown (every type, sorted) for the scrollable list.
  const crimeTypeList = useMemo(() => {
    if (!selectedHotspot) return [];
    return Object.entries(selectedHotspot.crimeTypes)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [selectedHotspot]);

  const poiPieData = useMemo(() => {
    if (!selectedHotspot?.poiTypes) return [];
    return Object.entries(selectedHotspot.poiTypes)
      .map(([name, value]) => ({ name, label: poiLabel(name), value }))
      .sort((a, b) => b.value - a.value);
  }, [selectedHotspot]);

  // ─── Click: select hotspot + fly to center ───────────────────────────────

  const handleDeckClick = (info: PickingInfo) => {
    if (!info.picked || !info.object) {
      setSelectedItem(null);
      setSelectedNodeKey(null);
      return;
    }
    // Node crime map: select the node and show its assigned crime count.
    if (info.layer?.id === "crime-nodes") {
      const o = info.object as RenderNode;
      setSelectedNodeKey(`${o.lat},${o.lng}`);
      return;
    }
    setSelectedNodeKey(null);
    const obj = info.object as { rank?: number; month?: string };
    if (obj.rank == null || !obj.month) return;

    setSelectedItem({ month: obj.month, rank: obj.rank });

    const spot = hotspotsData?.[obj.month]?.find((s) => s.rank === obj.rank);
    if (spot?.center) {
      const [lat, lng] = spot.center;
      triggerFlyTo(lat, lng);
    }
  };

  // ─── Three-tier opacity: selected=255 / similar=140 / others=22 ──────────

  const edgeColor = (d: EdgeDatum): [number, number, number, number] => {
    const [r, g, b, a] = hotspotColor(d.rank);
    if (hasLasso) return lassoKeys.has(`${d.month}|${d.rank}`) ? [r, g, b, 255] : [r, g, b, 22];
    if (!selectedItem) return [r, g, b, a];
    if (d.rank === selectedItem.rank && d.month === selectedItem.month) return [r, g, b, 255];
    if (similarKeys.has(`${d.month}|${d.rank}`)) return [r, g, b, 155];
    return [r, g, b, 22];
  };

  const edgeWidth = (d: EdgeDatum): number => {
    if (hasLasso) return lassoKeys.has(`${d.month}|${d.rank}`) ? 4 : 1;
    if (!selectedItem) return 2;
    if (d.rank === selectedItem.rank && d.month === selectedItem.month) return 5;
    if (similarKeys.has(`${d.month}|${d.rank}`)) return 2;
    return 1;
  };

  const nodeColor = (d: NodeDatum): [number, number, number, number] => {
    const [r, g, b, a] = hotspotColor(d.rank);
    if (hasLasso) return lassoKeys.has(`${d.month}|${d.rank}`) ? [r, g, b, 255] : [r, g, b, 22];
    if (!selectedItem) return [r, g, b, a];
    if (d.rank === selectedItem.rank && d.month === selectedItem.month) return [r, g, b, 255];
    if (similarKeys.has(`${d.month}|${d.rank}`)) return [r, g, b, 155];
    return [r, g, b, 22];
  };

  const nodeRadius = (d: NodeDatum): number => {
    if (hasLasso) return lassoKeys.has(`${d.month}|${d.rank}`) ? 7 : 3;
    if (!selectedItem) return 5;
    if (d.rank === selectedItem.rank && d.month === selectedItem.month) return 8;
    if (similarKeys.has(`${d.month}|${d.rank}`)) return 5;
    return 3;
  };

  const layers = [
    new HeatmapLayer<CrimeRecord>({
      id: "heatmap",
      data: showHeatmap ? filtered : [],
      getPosition: (d) => [d.lng, d.lat],
      getWeight: 1,
      aggregation: "SUM",
      radiusPixels: 35,
      intensity: 1,
      threshold: 0.05,
      colorRange: [
        [255, 237, 160],
        [254, 217, 118],
        [254, 178, 76],
        [253, 141, 60],
        [240, 59, 32],
        [189, 0, 38],
      ],
    }),
    new LineLayer<EdgeDatum>({
      id: "hotspot-edges",
      data: hotspotEdges,
      getSourcePosition: (d) => d.src,
      getTargetPosition: (d) => d.dst,
      getColor: edgeColor,
      getWidth: edgeWidth,
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 6,
      pickable: true,
      updateTriggers: {
        getColor: [selectedItem, lassoSelection],
        getWidth: [selectedItem, lassoSelection],
      },
    }),
    new ScatterplotLayer<NodeDatum>({
      id: "hotspot-nodes",
      data: hotspotNodes,
      getPosition: (d) => d.pos,
      getRadius: nodeRadius,
      radiusUnits: "pixels",
      radiusMinPixels: 2,
      radiusMaxPixels: 12,
      getFillColor: nodeColor,
      getLineColor: [255, 255, 255, 200],
      stroked: true,
      lineWidthMinPixels: 1,
      pickable: true,
      updateTriggers: {
        getFillColor: [selectedItem, lassoSelection],
        getRadius: [selectedItem, lassoSelection],
      },
    }),
    new ScatterplotLayer<CrimeRecord>({
      id: "crimes",
      data: showPoints ? filtered : [],
      getPosition: (d) => [d.lng, d.lat],
      getRadius: 1,
      radiusUnits: "pixels",
      radiusMinPixels: 1,
      radiusMaxPixels: 1,
      getFillColor: [254, 85, 11, 220],
      pickable: false,
    }),
    new ScatterplotLayer<PoiEntry>({
      id: "pois",
      data: allHotspotPois,
      getPosition: (d) => [d.lng, d.lat],
      getFillColor: (d) => {
        const [r, g, b] = POI_RGB[d.category] ?? POI_RGB.other;
        if (!selectedItem) return [r, g, b, 190];
        if (selectedPoiKeys.has(`${d.lat},${d.lng}`)) return [r, g, b, 245];
        return [r, g, b, 35];
      },
      getLineColor: [255, 255, 255, 200],
      getRadius: (d) => {
        if (!selectedItem) return 6;
        if (selectedPoiKeys.has(`${d.lat},${d.lng}`)) return 9;
        return 4;
      },
      radiusUnits: "pixels",
      radiusMinPixels: 3,
      radiusMaxPixels: 12,
      stroked: true,
      lineWidthMinPixels: 1.5,
      pickable: false,
      updateTriggers: {
        getFillColor: [selectedItem, selectedPoiKeys],
        getRadius: [selectedItem, selectedPoiKeys],
      },
    }),
    new ScatterplotLayer<RenderNode>({
      id: "crime-nodes",
      data: nodeRender,
      getPosition: (d) => [d.lng, d.lat],
      getFillColor: (d) => {
        const [r, g, b] = rampColor(Math.sqrt(d.count / nodeMax));
        return [r, g, b, 235];
      },
      // sqrt so the long tail of low-count corners stays distinguishable.
      getRadius: (d) => {
        const base = 2 + 4 * Math.sqrt(d.count / nodeMax);
        return `${d.lat},${d.lng}` === selectedNodeKey ? base + 4 : base;
      },
      radiusUnits: "pixels",
      radiusMinPixels: 2,
      radiusMaxPixels: 16,
      getLineColor: (d) =>
        `${d.lat},${d.lng}` === selectedNodeKey ? [17, 24, 39, 255] : [255, 255, 255, 130],
      getLineWidth: (d) => (`${d.lat},${d.lng}` === selectedNodeKey ? 2.5 : 0.5),
      lineWidthUnits: "pixels",
      stroked: true,
      pickable: true,
      updateTriggers: {
        getFillColor: [nodeMax],
        getRadius: [nodeMax, selectedNodeKey],
        getLineColor: [selectedNodeKey],
        getLineWidth: [selectedNodeKey],
      },
    }),
  ];

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #e5e7eb",
          flexShrink: 0,
          background: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ marginRight: "auto" }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "#111827", margin: 0 }}>
            Mapa de delitos
          </h3>
          <p style={{ fontSize: 11, color: "#9ca3af", margin: "2px 0 0" }}>
            {filtered.length} / {data.length} puntos
            {showHotspots && hotspotEdges.length > 0 && (
              <> · {hotspotNodes.length} nodos · {hotspotEdges.length} aristas</>
            )}
            {showNodes && nodeRender.length > 0 && (
              <> · {nodeRender.length.toLocaleString()} nodos con crímenes · máx {nodeMax}</>
            )}
          </p>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b7280" }}>
          Desde
          <input
            type="date" value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            style={{ fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, padding: "3px 7px", color: "#374151", outline: "none" }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b7280" }}>
          Hasta
          <input
            type="date" value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            style={{ fontSize: 12, border: "1px solid #e5e7eb", borderRadius: 4, padding: "3px 7px", color: "#374151", outline: "none" }}
          />
        </label>

        <button
          onClick={() => setShowPoints((v) => !v)}
          style={{
            padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none",
            borderRadius: 6, cursor: "pointer",
            background: showPoints ? "#FE550B" : "#f3f4f6",
            color: showPoints ? "#fff" : "#6b7280",
            transition: "background 0.15s, color 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          {showPoints ? "Ocultar puntos" : "Mostrar puntos"}
        </button>

        <button
          onClick={() => setShowHeatmap((v) => !v)}
          style={{
            padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none",
            borderRadius: 6, cursor: "pointer",
            background: showHeatmap ? "#F03B20" : "#f3f4f6",
            color: showHeatmap ? "#fff" : "#6b7280",
            transition: "background 0.15s, color 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          {showHeatmap ? "Ocultar mapa de calor" : "Mapa de calor"}
        </button>

        {nodesAvailable && nodesData && (
          <button
            onClick={() => { setShowNodes((v) => !v); if (showNodes) setSelectedNodeKey(null); }}
            style={{
              padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none",
              borderRadius: 6, cursor: "pointer",
              background: showNodes ? "#0D9488" : "#f3f4f6",
              color: showNodes ? "#fff" : "#6b7280",
              transition: "background 0.15s, color 0.15s",
              whiteSpace: "nowrap",
            }}
            title="Colorea cada nodo del street network por crímenes asignados (relativo al nodo más alto). Clic en un nodo para ver su conteo."
          >
            {showNodes ? "Ocultar nodos" : "Mapa de nodos"}
          </button>
        )}

        {hotspotsAvailable && hotspotsData && (
          <>
            <button
              onClick={() => { setShowHotspots((v) => !v); setSelectedItem(null); if (showHotspots) setShowPois(false); }}
              style={{
                padding: "5px 14px", fontSize: 12, fontWeight: 600, border: "none",
                borderRadius: 6, cursor: "pointer",
                background: showHotspots ? "#DC2626" : "#f3f4f6",
                color: showHotspots ? "#fff" : "#6b7280",
                transition: "background 0.15s, color 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {showHotspots ? "Ocultar hotspots" : "Mostrar hotspots"}
            </button>

            {showHotspots && (
              <button
                onClick={() => setShowPois((v) => !v)}
                style={{
                  padding: "5px 14px", fontSize: 12, fontWeight: 600,
                  border: `1.5px solid ${showPois ? "#8B5CF6" : "#e5e7eb"}`,
                  borderRadius: 6, cursor: "pointer",
                  background: showPois ? "#8B5CF6" : "#f9fafb",
                  color: showPois ? "#fff" : "#6b7280",
                  transition: "background 0.15s, color 0.15s, border-color 0.15s",
                  whiteSpace: "nowrap",
                }}
              >
                {showPois ? "Ocultar POIs" : "Mostrar POIs"}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Map canvas ──────────────────────────────────────────────────── */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <DeckGL
          style={{ position: "absolute", top: "0", left: "0", right: "0", bottom: "0" }}
          viewState={viewState}
          onViewStateChange={({ viewState: vs }) => setViewState(vs)}
          controller={true}
          layers={layers}
          onClick={handleDeckClick}
        >
          <Map
            ref={mapRef}
            mapboxAccessToken={MAPBOX_TOKEN}
            mapStyle="mapbox://styles/mapbox/light-v11"
          />
        </DeckGL>

        {/* ── Selected node info (node crime map) ──────────────────────── */}
        {showNodes && selectedNode && (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: 16,
              width: 200,
              background: "rgba(255,255,255,0.97)",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              padding: "12px 14px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.13)",
              zIndex: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                Nodo del street network
              </div>
              <button
                onClick={() => setSelectedNodeKey(null)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#9ca3af", lineHeight: 1, padding: "0 2px", marginTop: -2 }}
              >
                ×
              </button>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#B91C1C", lineHeight: 1 }}>
              {selectedNode.count.toLocaleString()}
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", margin: "2px 0 10px" }}>
              crímenes asignados a este nodo
            </div>
            <div style={{ height: 7, borderRadius: 4, background: "#f3f4f6", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(2, (100 * selectedNode.count) / nodeMax)}%`,
                  background: `rgb(${rampColor(Math.sqrt(selectedNode.count / nodeMax)).join(",")})`,
                }}
              />
            </div>
            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 5 }}>
              {((100 * selectedNode.count) / nodeMax).toFixed(0)}% del nodo más alto ({nodeMax})
            </div>
            {selectedNode.total !== selectedNode.count && (
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>
                Total histórico: {selectedNode.total.toLocaleString()}
              </div>
            )}
            <div style={{ fontSize: 10, color: "#cbd5e1", marginTop: 6 }}>
              {selectedNode.lat.toFixed(5)}, {selectedNode.lng.toFixed(5)}
            </div>
          </div>
        )}

        {/* ── Node crime map legend ────────────────────────────────────── */}
        {showNodes && nodeRender.length > 0 && !selectedNode && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              right: 16,
              background: "rgba(255,255,255,0.92)",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 11,
              color: "#374151",
              pointerEvents: "none",
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Crímenes por nodo</div>
            <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6 }}>
              Clic en un nodo para ver su conteo
            </div>
            <div
              style={{
                width: 150,
                height: 10,
                borderRadius: 3,
                background: `linear-gradient(to right, ${NODE_RAMP.map((c) => `rgb(${c.join(",")})`).join(",")})`,
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 10, color: "#9ca3af" }}>
              <span>1</span>
              <span>{nodeMax}</span>
            </div>
          </div>
        )}

        {/* ── Selected hotspot info panel ──────────────────────────────── */}
        {selectedHotspot && selectedItem && (
          <div
            style={{
              position: "absolute",
              top: 12,
              right: 16,
              width: 220,
              maxHeight: "80vh",
              overflowY: "auto",
              background: "rgba(255,255,255,0.97)",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              padding: "12px 14px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.13)",
              zIndex: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>
                  Hotspot #{selectedItem.rank}
                </div>
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 1 }}>
                  {selectedItem.month}
                </div>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 18, color: "#9ca3af", lineHeight: 1, padding: "0 2px", marginTop: -2,
                }}
              >
                ×
              </button>
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1, background: "#fef2f2", borderRadius: 6, padding: "6px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#DC2626" }}>
                  {selectedHotspot.crimes.toLocaleString()}
                </div>
                <div style={{ fontSize: 10, color: "#9ca3af" }}>crímenes</div>
              </div>
              <div style={{ flex: 1, background: "#f9fafb", borderRadius: 6, padding: "6px 10px", textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#374151" }}>
                  {selectedHotspot.nodes.length}
                </div>
                <div style={{ fontSize: 10, color: "#9ca3af" }}>nodos</div>
              </div>
            </div>

            {pieData.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 4 }}>
                  Tipos de delito
                </div>
                <PieChart width={192} height={150}>
                  <Pie
                    data={pieData}
                    cx={96} cy={65}
                    innerRadius={28} outerRadius={55}
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {pieData.map((entry) => (
                      <Cell key={entry.name} fill={crimeColor(entry.name)} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }}
                  />
                </PieChart>
                <div style={{ marginTop: 4, maxHeight: 110, overflowY: "auto", paddingRight: 2 }}>
                  {crimeTypeList.map((d) => (
                    <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3, fontSize: 10, color: "#374151" }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: crimeColor(d.name) }} />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {crimeLabel(d.name)}
                      </span>
                      <span style={{ fontWeight: 600, flexShrink: 0 }}>{d.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {poiPieData.length > 0 && (
              <>
                <div style={{ borderTop: "1px solid #f3f4f6", margin: "10px 0 8px" }} />
                <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", marginBottom: 4 }}>
                  POIs en la zona
                  <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6 }}>
                    {selectedHotspot!.pois.length} lugares
                  </span>
                </div>
                <PieChart width={192} height={150}>
                  <Pie
                    data={poiPieData}
                    cx={96} cy={65}
                    innerRadius={28} outerRadius={55}
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {poiPieData.map((entry) => (
                      <Cell key={entry.name} fill={poiColor(entry.name)} />
                    ))}
                  </Pie>
                  <RechartsTooltip
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(v: any, _n: any, p: any) => [v, p.payload?.label]}
                    contentStyle={{ fontSize: 11, borderRadius: 6, border: "1px solid #e5e7eb" }}
                  />
                </PieChart>
                <div style={{ marginTop: 4, maxHeight: 110, overflowY: "auto", paddingRight: 2 }}>
                  {poiPieData.map((d) => (
                    <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3, fontSize: 10, color: "#374151" }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: poiColor(d.name) }} />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {d.label}
                      </span>
                      <span style={{ fontWeight: 600, flexShrink: 0 }}>{d.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Legend hotspots ──────────────────────────────────────────── */}
        {showHotspots && hotspotEdges.length > 0 && !selectedItem && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              right: 16,
              background: "rgba(255,255,255,0.92)",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 11,
              color: "#374151",
              pointerEvents: "none",
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Top-20 hotspots / mes</div>
            <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 6 }}>
              Clic en nodo o arista para detalles
            </div>
            {[1, 5, 10, 15, 20].map((rank) => {
              const [r, g, b, a] = hotspotColor(rank);
              return (
                <div key={rank} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <div
                    style={{
                      width: 10, height: 10, borderRadius: "50%",
                      background: `rgba(${r},${g},${b},${a / 255})`,
                      border: "1.5px solid rgba(255,255,255,0.8)",
                    }}
                  />
                  <span>#{rank}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Legend POIs ───────────────────────────────────────────────── */}
        {showHotspots && showPois && allHotspotPois.length > 0 && !selectedItem && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              left: 16,
              background: "rgba(255,255,255,0.92)",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 11,
              color: "#374151",
              pointerEvents: "none",
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              POIs · {allHotspotPois.length}
            </div>
            {([...new Set(allHotspotPois.map((p) => p.category))] as string[])
              .sort()
              .map((cat) => (
                <div key={cat} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <div
                    style={{
                      width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
                      background: poiColor(cat),
                      border: "1.5px solid rgba(255,255,255,0.8)",
                    }}
                  />
                  <span>{poiLabel(cat)}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CrimeMap;
