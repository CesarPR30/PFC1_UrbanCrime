import React, { useMemo } from "react";
import type { Hotspot } from "../hooks/useHotspots";
import { crimeColor } from "../theme";

/**
 * SubgraphGlyph — a tiny, normalized drawing of a subgraph's road-network shape.
 *
 * The basin's node/edge geometry (lat/lng) is rescaled into a unit box and the
 * aspect ratio preserved, so the glyph shows the *topology* of the subgraph
 * independent of where it sits in the city. Rendering the real shape next to
 * the UMAP-based "similar" list lets the reader verify by eye that subgraphs
 * the embedding calls similar actually look alike — the core claim of the work.
 */

function dominantType(h: Hotspot): string {
  let best = "";
  let max = -1;
  for (const [t, c] of Object.entries(h.crimeTypes ?? {})) {
    if (c > max) { max = c; best = t; }
  }
  return best;
}

interface Props {
  spot: Hotspot;
  size?: number;
  /** Outline-only when faded (used for the reference glyph vs. peers). */
  muted?: boolean;
}

const SubgraphGlyph: React.FC<Props> = ({ spot, size = 40, muted = false }) => {
  const color = crimeColor(dominantType(spot));

  const { lines, dots } = useMemo(() => {
    const pts = spot.nodes;
    if (!pts.length) return { lines: [] as number[][], dots: [] as number[][] };

    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lat, lng] of pts) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    const spanLat = maxLat - minLat || 1e-6;
    const spanLng = maxLng - minLng || 1e-6;
    // Preserve aspect ratio: scale both axes by the larger span, then centre.
    const span = Math.max(spanLat, spanLng);
    const pad = 0.12;
    const usable = 1 - 2 * pad;
    const offLat = (span - spanLat) / 2;
    const offLng = (span - spanLng) / 2;

    // lng → x, lat → y (flipped so north is up).
    const nx = (lng: number) => (pad + ((lng - minLng + offLng) / span) * usable) * size;
    const ny = (lat: number) => (pad + (1 - (lat - minLat + offLat) / span) * usable) * size;

    const lines = spot.edges.map(([[la1, lo1], [la2, lo2]]) => [
      nx(lo1), ny(la1), nx(lo2), ny(la2),
    ]);
    const dots = pts.map(([lat, lng]) => [nx(lng), ny(lat)]);
    return { lines, dots };
  }, [spot, size]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect x={0.5} y={0.5} width={size - 1} height={size - 1} rx={5}
        fill={muted ? "#fafafa" : "#ffffff"} stroke="#e5e7eb" strokeWidth={1} />
      {lines.map((l, i) => (
        <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]}
          stroke={color} strokeOpacity={muted ? 0.5 : 0.85}
          strokeWidth={1} strokeLinecap="round" />
      ))}
      {dots.map((d, i) => (
        <circle key={i} cx={d[0]} cy={d[1]} r={1} fill={color}
          fillOpacity={muted ? 0.5 : 0.95} />
      ))}
    </svg>
  );
};

export default SubgraphGlyph;
