import React, { useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { Hotspot } from "../hooks/useHotspots";
import type { SelectedItem } from "../store/useHotspotStore";

/**
 * HistoryPanel — temporal profile of the selected subgraph's *footprint*.
 *
 * Each subgraph carries `history`: the monthly crime count inside its spatial
 * footprint across the whole study window (precomputed offline). This chart
 * answers "¿cómo varió el crimen en esta zona a lo largo del histórico?":
 *
 *   · orange line  – the selected (reference) subgraph's footprint series,
 *                    with a marker on the month the subgraph was detected;
 *   · teal line    – the comparison target's series (when "vs" is active),
 *                    so two topologically similar zones can be compared not
 *                    just on one month but on their whole temporal behaviour;
 *   · gray lines   – the similar subgraphs' series, as context.
 *
 * Hovering tracks the nearest month and reports the exact values.
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
function shortMonth(key: string): string {
  const [year, mon] = key.split("-");
  return `${MONTH_NAMES[mon] ?? mon}'${year.slice(2)}`;
}

export interface SeriesEntry {
  item: SelectedItem;
  spot: Hotspot;
}

interface Props {
  /** Sorted month keys; every `history` array is aligned with this list. */
  months: string[];
  selected: SeriesEntry;
  compare: SeriesEntry | null;
  similars: SeriesEntry[];
}

const W = 272;
const H = 128;
const M = { top: 8, right: 8, bottom: 18, left: 30 };

const SELECTED_COLOR = "#FE550B";
const COMPARE_COLOR = "#0D9488";
const SIMILAR_COLOR = "#d1d5db";

const HistoryPanel: React.FC<Props> = ({ months, selected, compare, similars }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const iW = W - M.left - M.right;
  const iH = H - M.top - M.bottom;

  const { x, y, linePath, simPaths, cmpPath, selMonthIdx, cmpMonthIdx } = useMemo(() => {
    const x = d3.scaleLinear().domain([0, Math.max(months.length - 1, 1)]).range([0, iW]);

    const all: number[] = [
      ...(selected.spot.history ?? []),
      ...(compare?.spot.history ?? []),
      ...similars.flatMap((s) => s.spot.history ?? []),
    ];
    const yMax = Math.max(d3.max(all) ?? 1, 1);
    const y = d3.scaleLinear().domain([0, yMax * 1.08]).range([iH, 0]).nice();

    const lineFn = d3
      .line<number>()
      .x((_, i) => x(i))
      .y((v) => y(v))
      .curve(d3.curveMonotoneX);

    return {
      x,
      y,
      linePath: lineFn(selected.spot.history ?? []) ?? "",
      cmpPath: compare ? lineFn(compare.spot.history ?? []) ?? "" : "",
      simPaths: similars.map((s) => lineFn(s.spot.history ?? []) ?? ""),
      selMonthIdx: months.indexOf(selected.item.month),
      cmpMonthIdx: compare ? months.indexOf(compare.item.month) : -1,
    };
  }, [months, selected, compare, similars, iW, iH]);

  const selHistory = selected.spot.history ?? [];
  if (selHistory.length === 0) return null;

  // Hover: nearest month index from the pointer's x position in viewBox units.
  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W - M.left;
    const idx = Math.round(x.invert(Math.max(0, Math.min(iW, px))));
    setHoverIdx(Math.max(0, Math.min(months.length - 1, idx)));
  };

  // X ticks: ~6 evenly spaced months.
  const tickStep = Math.max(1, Math.ceil(months.length / 6));
  const ticks = months.map((_, i) => i).filter((i) => i % tickStep === 0);

  const hoverSel = hoverIdx != null ? selHistory[hoverIdx] : null;
  const hoverCmp =
    hoverIdx != null && compare ? (compare.spot.history ?? [])[hoverIdx] : null;

  return (
    <div className="history-panel">
      <div className="history-panel__header">
        <span className="history-panel__title">Evolución histórica de la zona</span>
        {hoverIdx != null ? (
          <span className="history-panel__hover">
            {shortMonth(months[hoverIdx])} ·{" "}
            <strong style={{ color: SELECTED_COLOR }}>{hoverSel}</strong>
            {hoverCmp != null && (
              <>
                {" "}vs <strong style={{ color: COMPARE_COLOR }}>{hoverCmp}</strong>
              </>
            )}
          </span>
        ) : (
          <span className="history-panel__hover history-panel__hover--muted">
            delitos / mes en el footprint
          </span>
        )}
      </div>

      <svg
        ref={svgRef}
        className="history-panel__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <g transform={`translate(${M.left},${M.top})`}>
          {/* Y axis ticks */}
          {y.ticks(3).map((t) => (
            <g key={t}>
              <line x1={0} x2={iW} y1={y(t)} y2={y(t)} stroke="#f3f4f6" strokeDasharray="3 2" />
              <text x={-5} y={y(t)} dy="0.32em" textAnchor="end" fontSize={8} fill="#9ca3af">
                {t}
              </text>
            </g>
          ))}

          {/* X axis labels */}
          {ticks.map((i) => (
            <text key={i} x={x(i)} y={iH + 12} textAnchor="middle" fontSize={8} fill="#9ca3af">
              {shortMonth(months[i])}
            </text>
          ))}

          {/* Similar subgraphs: thin context lines */}
          {simPaths.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={SIMILAR_COLOR} strokeWidth={1} strokeOpacity={0.8} />
          ))}

          {/* Comparison series */}
          {cmpPath && (
            <path d={cmpPath} fill="none" stroke={COMPARE_COLOR} strokeWidth={1.8} strokeLinejoin="round" />
          )}

          {/* Selected series */}
          <path d={linePath} fill="none" stroke={SELECTED_COLOR} strokeWidth={2.2} strokeLinejoin="round" />

          {/* Marker: month the reference subgraph was detected */}
          {selMonthIdx >= 0 && (
            <>
              <line
                x1={x(selMonthIdx)} x2={x(selMonthIdx)} y1={0} y2={iH}
                stroke={SELECTED_COLOR} strokeOpacity={0.35} strokeDasharray="3 2"
              />
              <circle
                cx={x(selMonthIdx)} cy={y(selHistory[selMonthIdx] ?? 0)} r={3.2}
                fill={SELECTED_COLOR} stroke="#fff" strokeWidth={1.2}
              />
            </>
          )}

          {/* Marker: month the comparison subgraph was detected */}
          {compare && cmpMonthIdx >= 0 && (
            <circle
              cx={x(cmpMonthIdx)}
              cy={y((compare.spot.history ?? [])[cmpMonthIdx] ?? 0)}
              r={3.2}
              fill={COMPARE_COLOR}
              stroke="#fff"
              strokeWidth={1.2}
            />
          )}

          {/* Hover crosshair */}
          {hoverIdx != null && (
            <line
              x1={x(hoverIdx)} x2={x(hoverIdx)} y1={0} y2={iH}
              stroke="#9ca3af" strokeOpacity={0.5} strokeWidth={0.8}
            />
          )}
        </g>
      </svg>

      <div className="history-panel__legend">
        <span className="history-panel__legend-item">
          <span className="history-panel__legend-swatch" style={{ background: SELECTED_COLOR }} />
          #{selected.item.rank} {formatMonth(selected.item.month)}
        </span>
        {compare && (
          <span className="history-panel__legend-item">
            <span className="history-panel__legend-swatch" style={{ background: COMPARE_COLOR }} />
            #{compare.item.rank} {formatMonth(compare.item.month)}
          </span>
        )}
        {similars.length > 0 && (
          <span className="history-panel__legend-item">
            <span className="history-panel__legend-swatch" style={{ background: SIMILAR_COLOR }} />
            similares
          </span>
        )}
      </div>
    </div>
  );
};

export default HistoryPanel;
