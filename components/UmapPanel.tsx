import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useHotspots } from "../hooks/useHotspots";
import type { Hotspot } from "../hooks/useHotspots";
import { useHotspotStore } from "../store/useHotspotStore";
import { CRIME_ORDER, crimeColor, crimeLabel } from "../theme";

/**
 * UmapPanel — left-hand 2-D map of every crime subgraph.
 *
 * Each point is one monthly hotspot subgraph, positioned by `embed2d`: the
 * UMAP projection of its fused descriptor (NetLSD topology + historical
 * footprint + POI land-use mix + crime composition) computed offline. Points
 * that sit close together are structurally / temporally / functionally alike.
 *
 * Colour encodes the dominant crime type so clusters are readable at a glance;
 * clicking a point selects that subgraph (and flies the map to it). When a
 * subgraph is selected, faint links connect it to its topologically most
 * similar subgraphs and everything else dims, so "what looks like this?" is
 * answered directly on the map.
 *
 * The "Lazo" tool enables free-form selection: drag a loop around any group of
 * points and every subgraph inside it is selected at once. The loop is captured
 * with d3-drag, its pointer coordinates are transformed into the SVG's own
 * coordinate space via getScreenCTM (so the hit-test matches what's drawn), and
 * membership is decided with d3.polygonContains. The resulting set is shared
 * through the store so the crime map highlights the same subgraphs.
 *
 * EMBEDDING SPACES — the scatter can be laid out in two precomputed spaces,
 * both built only from the road network (crime never shapes the layout, so
 * "neighbours with different crime" is always a legitimate finding):
 *   Topología   (embedTopo) – road-network shape only (NetLSD + geometry).
 *   Topo+Vía    (embed2d)   – shape + road hierarchy (expressway / avenue /
 *                             collector / street): same shape but built of
 *                             avenues vs. residential streets now separates.
 * Colour can encode the dominant crime type (categorical) or the crime count
 * (sequential ramp) — the latter is how you *see* whether structurally similar
 * zones share crime levels.
 */

const MONTH_NAMES: Record<string, string> = {
  "01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr",
  "05": "May", "06": "Jun", "07": "Jul", "08": "Ago",
  "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dic",
};
function formatMonth(key: string): string {
  const [year, mon] = key.split("-");
  return `${MONTH_NAMES[mon] ?? mon} ${year}`;
}

function dominantType(h: Hotspot): string {
  let best = "";
  let max = -1;
  for (const [t, c] of Object.entries(h.crimeTypes ?? {})) {
    if (c > max) { max = c; best = t; }
  }
  return best;
}

interface Pt {
  month: string;
  rank: number;
  x: number;
  y: number;
  crimes: number;
  type: string;
  center: [number, number] | null;
}

const VB = 100; // SVG viewBox size; embed2d is in [0, 1] → scaled to [0, VB]

const keyOf = (month: string, rank: number) => `${month}|${rank}`;

/** Which precomputed 2-D projection lays out the scatter. */
type EmbedSpace = "topo" | "topoRoad";

const SPACES: { id: EmbedSpace; label: string; title: string }[] = [
  {
    id: "topo",
    label: "Topología",
    title:
      "Solo la forma de la red vial (NetLSD + geometría). El crimen NO participa en la agrupación: vecinos con criminalidad distinta son un hallazgo.",
  },
  {
    id: "topoRoad",
    label: "+Vía",
    title:
      "Topología + jerarquía vial (autopista / avenida / colectora / calle). Misma forma pero hecha de avenidas vs. calles residenciales se separa.",
  },
];

function coordOf(s: Hotspot, space: EmbedSpace): [number, number] | undefined {
  if (space === "topo") return s.embedTopo ?? s.embed2d;
  return s.embed2d;
}

const UmapPanel: React.FC = () => {
  const { data, loading } = useHotspots();
  const {
    selectedItem, setSelectedItem, compareItem, triggerFlyTo,
    lassoSelection, setLassoSelection,
  } = useHotspotStore();
  const [hover, setHover] = useState<Pt | null>(null);

  // Embedding space + colour encoding ("type" = dominant crime type,
  // "count" = sequential ramp by crime volume).
  const [space, setSpace] = useState<EmbedSpace>("topoRoad");
  const [colorMode, setColorMode] = useState<"type" | "count">("type");

  // Lasso tooling: a toggle for the mode, the live loop being drawn (in viewBox
  // coordinates), and refs so the d3-drag handlers always see current values.
  const [lassoMode, setLassoMode] = useState(false);
  const [lassoPath, setLassoPath] = useState<[number, number][]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const overlayRef = useRef<SVGRectElement | null>(null);

  const points = useMemo<Pt[]>(() => {
    if (!data) return [];
    const out: Pt[] = [];
    for (const [month, spots] of Object.entries(data)) {
      for (const s of spots) {
        const xy = coordOf(s, space);
        if (!xy) continue;
        out.push({
          month,
          rank: s.rank,
          x: xy[0] * VB,
          // SVG y grows downward → flip so the layout reads like a normal plot
          y: (1 - xy[1]) * VB,
          crimes: s.crimes,
          type: dominantType(s),
          center: s.center,
        });
      }
    }
    return out;
  }, [data, space]);

  // Fast position lookup so we can draw links to similar subgraphs.
  const ptByKey = useMemo(() => {
    const m = new Map<string, Pt>();
    for (const p of points) m.set(keyOf(p.month, p.rank), p);
    return m;
  }, [points]);

  // The selected subgraph and the links to its most-similar peers.
  const selectedPt = selectedItem
    ? ptByKey.get(keyOf(selectedItem.month, selectedItem.rank)) ?? null
    : null;

  const similarLinks = useMemo(() => {
    if (!selectedPt || !data) return [];
    const spot = data[selectedPt.month]?.find((s) => s.rank === selectedPt.rank);
    if (!spot?.similarTo) return [];
    const links: { to: Pt; similarity: number }[] = [];
    for (const sim of spot.similarTo) {
      const to = ptByKey.get(keyOf(sim.month, sim.rank));
      if (to) links.push({ to, similarity: sim.similarity });
    }
    return links;
  }, [selectedPt, data, ptByKey]);

  const similarKeys = useMemo(
    () => new Set(similarLinks.map((l) => keyOf(l.to.month, l.to.rank))),
    [similarLinks],
  );

  const lassoKeys = useMemo(
    () => new Set(lassoSelection.map((s) => keyOf(s.month, s.rank))),
    [lassoSelection],
  );

  // Keep a live ref to the points so the d3-drag handlers (attached once per
  // lasso-mode toggle) always hit-test against the current layout.
  const pointsRef = useRef<Pt[]>(points);
  pointsRef.current = points;

  // ─── d3 lasso ─────────────────────────────────────────────────────────────
  // While the lasso tool is active, an invisible overlay rect captures pointer
  // drags. d3-drag reports each pointer position in the SVG's user space
  // (it inverts getScreenCTM under the hood), so the loop we record lines up
  // with the rendered points and with d3.polygonContains' hit-test.
  useEffect(() => {
    const overlay = overlayRef.current;
    const svg = svgRef.current;
    if (!lassoMode || !overlay || !svg) return;

    let loop: [number, number][] = [];

    const drag = d3
      .drag<SVGRectElement, unknown>()
      // Compute pointer coordinates relative to the <svg>, i.e. in viewBox units.
      .container(() => svg)
      .on("start", (event) => {
        loop = [[event.x, event.y]];
        setLassoPath(loop);
      })
      .on("drag", (event) => {
        loop.push([event.x, event.y]);
        setLassoPath([...loop]);
      })
      .on("end", () => {
        if (loop.length >= 3) {
          const hits = pointsRef.current.filter((p) =>
            d3.polygonContains(loop, [p.x, p.y]),
          );
          setLassoSelection(hits.map((p) => ({ month: p.month, rank: p.rank })));
        }
        loop = [];
        setLassoPath([]);
      });

    d3.select(overlay).call(drag);
    return () => {
      d3.select(overlay).on(".drag", null);
    };
  }, [lassoMode, setLassoSelection]);

  // Leaving lasso mode clears any half-drawn loop.
  useEffect(() => {
    if (!lassoMode) setLassoPath([]);
  }, [lassoMode]);

  const lassoD =
    lassoPath.length > 1
      ? "M" + lassoPath.map(([x, y]) => `${x},${y}`).join("L") + "Z"
      : "";

  if (loading) {
    return <div className="umap-panel__empty">Cargando embedding…</div>;
  }
  if (points.length === 0) {
    return <div className="umap-panel__empty">Sin datos de embedding</div>;
  }

  // Radius scaled by crime volume (sqrt → area roughly proportional to crimes).
  const maxCrimes = Math.max(...points.map((p) => p.crimes), 1);
  const radius = (c: number) => 1.1 + 2.4 * Math.sqrt(c / maxCrimes);

  // Sequential fill for the "Nº delitos" colour mode (sqrt keeps the long
  // low-count tail distinguishable; 0.12 offset avoids near-white points).
  const countFill = (c: number) =>
    d3.interpolateYlOrRd(0.12 + 0.88 * Math.sqrt(c / maxCrimes));
  const fillOf = (p: Pt) =>
    colorMode === "type" ? crimeColor(p.type) : countFill(p.crimes);

  const isSelected = (p: Pt) =>
    selectedItem?.month === p.month && selectedItem?.rank === p.rank;
  const isCompared = (p: Pt) =>
    compareItem?.month === p.month && compareItem?.rank === p.rank;

  const hasLasso = lassoSelection.length > 0;

  const spaceLabel = SPACES.find((s) => s.id === space)?.label ?? "";
  const subtitle = hasLasso
    ? `${lassoSelection.length} seleccionadas con lazo`
    : selectedPt
      ? `#${selectedPt.rank} · ${similarLinks.length} similares resaltados`
      : `UMAP (${spaceLabel}) · ${points.length} zonas`;

  return (
    <div className="umap-panel">
      <div className="umap-panel__header">
        <div className="umap-panel__header-row">
          <span className="umap-panel__title">Mapa de subgrafos</span>
          <div className="umap-panel__tools">
            <button
              type="button"
              className={
                "umap-panel__tool" + (lassoMode ? " umap-panel__tool--active" : "")
              }
              aria-pressed={lassoMode}
              onClick={() => setLassoMode((m) => !m)}
              title="Selección de lazo: arrastra un lazo alrededor de varias zonas"
            >
              Lazo
            </button>
            {hasLasso && (
              <button
                type="button"
                className="umap-panel__tool"
                onClick={() => setLassoSelection([])}
                title="Limpiar selección de lazo"
              >
                Limpiar
              </button>
            )}
          </div>
        </div>
        {/* Embedding-space selector: what "parecido" means in this scatter. */}
        <div className="umap-panel__segs">
          <div className="umap-panel__seg" role="group" aria-label="Espacio de embedding">
            {SPACES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={
                  "umap-panel__seg-btn" +
                  (space === s.id ? " umap-panel__seg-btn--active" : "")
                }
                onClick={() => setSpace(s.id)}
                title={s.title}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="umap-panel__seg" role="group" aria-label="Codificación de color">
            <button
              type="button"
              className={
                "umap-panel__seg-btn" +
                (colorMode === "type" ? " umap-panel__seg-btn--active" : "")
              }
              onClick={() => setColorMode("type")}
              title="Color por tipo de delito dominante"
            >
              Tipo
            </button>
            <button
              type="button"
              className={
                "umap-panel__seg-btn" +
                (colorMode === "count" ? " umap-panel__seg-btn--active" : "")
              }
              onClick={() => setColorMode("count")}
              title="Color por número de delitos: permite ver si zonas vecinas (parecidas) comparten nivel de criminalidad"
            >
              Nº delitos
            </button>
          </div>
        </div>
        <span className="umap-panel__subtitle">{subtitle}</span>
      </div>

      <div className="umap-panel__plot-wrap">
        <svg
          ref={svgRef}
          className={"umap-panel__svg" + (lassoMode ? " umap-panel__svg--lasso" : "")}
          viewBox={`-4 -4 ${VB + 8} ${VB + 8}`}
          preserveAspectRatio="xMidYMid meet"
          onMouseLeave={() => setHover(null)}
        >
          {/* Links from the selected subgraph to its most similar peers. */}
          {selectedPt &&
            similarLinks.map((l) => (
              <line
                key={`link-${l.to.month}-${l.to.rank}`}
                x1={selectedPt.x}
                y1={selectedPt.y}
                x2={l.to.x}
                y2={l.to.y}
                stroke="#111827"
                strokeWidth={0.3 + l.similarity * 0.9}
                strokeOpacity={0.18 + l.similarity * 0.32}
                strokeLinecap="round"
              />
            ))}

          {points.map((p) => {
            const sel = isSelected(p);
            const cmp = isCompared(p);
            const isSim = similarKeys.has(keyOf(p.month, p.rank));
            const inLasso = lassoKeys.has(keyOf(p.month, p.rank));
            // A point is "highlighted" if it's the single selection, the
            // comparison target, one of its similar peers, or in the lasso set.
            const hl = sel || cmp || isSim || inLasso;
            // Dim everything that isn't highlighted while any selection is active.
            const dimmed = (selectedPt != null || hasLasso) && !hl;
            return (
              <circle
                key={`${p.month}-${p.rank}`}
                cx={p.x}
                cy={p.y}
                r={
                  sel || cmp
                    ? radius(p.crimes) + 1.6
                    : isSim || inLasso
                      ? radius(p.crimes) + 0.8
                      : radius(p.crimes)
                }
                fill={fillOf(p)}
                fillOpacity={dimmed ? 0.18 : sel || cmp || inLasso ? 1 : 0.78}
                stroke={cmp ? "#0D9488" : hl ? "#111827" : "#ffffff"}
                strokeWidth={sel || cmp ? 1.4 : isSim || inLasso ? 0.9 : 0.4}
                style={{ cursor: lassoMode ? "crosshair" : "pointer" }}
                onMouseEnter={() => setHover(p)}
                onClick={() => {
                  if (lassoMode) return; // the overlay handles drags in lasso mode
                  setSelectedItem({ month: p.month, rank: p.rank });
                  if (p.center) triggerFlyTo(p.center[0], p.center[1]);
                }}
              />
            );
          })}

          {/* The loop currently being drawn with the lasso tool. */}
          {lassoMode && lassoD && (
            <path
              className="umap-panel__lasso"
              d={lassoD}
              fill="rgba(37, 99, 235, 0.10)"
              stroke="#2563eb"
              strokeWidth={0.6}
              strokeDasharray="2 1.5"
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}

          {/* Transparent capture surface for d3-drag — only while lasso is on. */}
          {lassoMode && (
            <rect
              ref={overlayRef}
              x={-4}
              y={-4}
              width={VB + 8}
              height={VB + 8}
              fill="transparent"
              style={{ cursor: "crosshair" }}
            />
          )}
        </svg>

        {hover && (
          <div className="umap-panel__tooltip">
            <strong>#{hover.rank}</strong> · {formatMonth(hover.month)}
            <br />
            {hover.crimes} delitos · {crimeLabel(hover.type).toLowerCase()}
          </div>
        )}
      </div>

      {colorMode === "type" ? (
        <ul className="umap-panel__legend">
          {CRIME_ORDER.map((t) => (
            <li key={t} className="umap-panel__legend-item">
              <span
                className="umap-panel__legend-dot"
                style={{ background: crimeColor(t) }}
              />
              <span className="umap-panel__legend-label">{crimeLabel(t)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="umap-panel__gradient-legend">
          <span className="umap-panel__legend-label">1</span>
          <div
            className="umap-panel__gradient-bar"
            style={{
              background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
                .map((t) => d3.interpolateYlOrRd(0.12 + 0.88 * t))
                .join(",")})`,
            }}
          />
          <span className="umap-panel__legend-label">{maxCrimes} delitos</span>
        </div>
      )}
    </div>
  );
};

export default UmapPanel;
