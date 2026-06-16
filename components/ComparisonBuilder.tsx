import React, { useMemo, useState } from "react";
import * as d3 from "d3";
import { useHotspotStore } from "../store/useHotspotStore";
import { useHotspots } from "../hooks/useHotspots";
import SubgraphGlyph from "./SubgraphGlyph";
import { DRAG_MIME } from "./CandidateList";
import type { Hotspot } from "../hooks/useHotspots";
import type { SelectedItem, CompareSide } from "../store/useHotspotStore";
import { crimeColor, crimeLabel, poiColor, poiLabel } from "../theme";

/**
 * ComparisonBuilder — drag-and-drop A-vs-B comparison shown in the right panel.
 *
 * Subgraphs are dragged in from the CandidateList (left sidebar) and dropped
 * onto the A or B zone. Each side accepts *several* subgraphs and SUMS their
 * data (crimes, crime mix, POI mix, footprint history), so the contrast can be
 * "this group of zones vs that group", not only one-to-one. Every member shows
 * an × to drop it from the comparison.
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

const A_COLOR = "#FE550B";
const B_COLOR = "#ffbfa3";

interface SideAgg {
  members: { item: SelectedItem; spot: Hotspot }[];
  crimes: number;
  crimeTypes: Record<string, number>;
  poiTypes: Record<string, number>;
  nodes: number;
  pois: number;
  history: number[] | null;
}

function aggregateSide(
  items: SelectedItem[],
  data: Record<string, Hotspot[]> | null,
  monthCount: number,
): SideAgg {
  const members: SideAgg["members"] = [];
  const crimeTypes: Record<string, number> = {};
  const poiTypes: Record<string, number> = {};
  let crimes = 0, nodes = 0, pois = 0;
  const history = new Array(monthCount).fill(0);
  let hasHistory = false;

  for (const it of items) {
    const spot = data?.[it.month]?.find((s) => s.rank === it.rank);
    if (!spot) continue;
    members.push({ item: it, spot });
    crimes += spot.crimes;
    nodes += spot.nodes.length;
    pois += (spot.pois ?? []).length;
    for (const [k, v] of Object.entries(spot.crimeTypes ?? {})) crimeTypes[k] = (crimeTypes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(spot.poiTypes ?? {})) poiTypes[k] = (poiTypes[k] ?? 0) + v;
    if (spot.history?.length) {
      hasHistory = true;
      for (let i = 0; i < monthCount; i++) history[i] += spot.history[i] ?? 0;
    }
  }

  return { members, crimes, crimeTypes, poiTypes, nodes, pois, history: hasHistory ? history : null };
}

interface PairedRow {
  key: string;
  label: string;
  color: string;
  a: number;
  b: number;
}

function pairedRows(
  aCounts: Record<string, number>,
  bCounts: Record<string, number>,
  labelFn: (k: string) => string,
  colorFn: (k: string) => string,
): PairedRow[] {
  const keys = [...new Set([...Object.keys(aCounts), ...Object.keys(bCounts)])];
  return keys
    .map((k) => ({ key: k, label: labelFn(k), color: colorFn(k), a: aCounts[k] ?? 0, b: bCounts[k] ?? 0 }))
    .sort((r1, r2) => Math.max(r2.a, r2.b) - Math.max(r1.a, r1.b));
}

const PairedBar: React.FC<{ row: PairedRow; max: number }> = ({ row, max }) => {
  const exclusive = (row.a === 0) !== (row.b === 0);
  return (
    <div className={"compare-panel__row" + (exclusive ? " compare-panel__row--exclusive" : "")}>
      <span className="compare-panel__row-val">{row.a > 0 ? row.a : "—"}</span>
      <div className="compare-panel__row-bar compare-panel__row-bar--a">
        <span style={{ width: `${(100 * row.a) / max}%`, background: A_COLOR }} />
      </div>
      <span className="compare-panel__row-label" title={row.label}>
        <span className="compare-panel__row-dot" style={{ background: row.color }} />
        {row.label}
        {exclusive && <em className="compare-panel__row-flag">solo {row.a > 0 ? "A" : "B"}</em>}
      </span>
      <div className="compare-panel__row-bar compare-panel__row-bar--b">
        <span style={{ width: `${(100 * row.b) / max}%`, background: B_COLOR }} />
      </div>
      <span className="compare-panel__row-val">{row.b > 0 ? row.b : "—"}</span>
    </div>
  );
};

/** Compact A-vs-B line chart of the two sides' summed footprint history. */
const SummedHistory: React.FC<{ months: string[]; a: number[] | null; b: number[] | null }> = ({ months, a, b }) => {
  const W = 272, H = 120, M = { top: 8, right: 8, bottom: 18, left: 30 };
  const iW = W - M.left - M.right, iH = H - M.top - M.bottom;

  const { x, y, aPath, bPath, ticks } = useMemo(() => {
    const x = d3.scaleLinear().domain([0, Math.max(months.length - 1, 1)]).range([0, iW]);
    const all = [...(a ?? []), ...(b ?? [])];
    const yMax = Math.max(d3.max(all) ?? 1, 1);
    const y = d3.scaleLinear().domain([0, yMax * 1.08]).range([iH, 0]).nice();
    const line = d3.line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(d3.curveMonotoneX);
    const step = Math.max(1, Math.ceil(months.length / 6));
    return {
      x, y,
      aPath: a ? line(a) ?? "" : "",
      bPath: b ? line(b) ?? "" : "",
      ticks: months.map((_, i) => i).filter((i) => i % step === 0),
    };
  }, [months, a, b, iW, iH]);

  if (!a && !b) return null;

  return (
    <svg className="cmpb__history" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <g transform={`translate(${M.left},${M.top})`}>
        {y.ticks(3).map((t) => (
          <g key={t}>
            <line x1={0} x2={iW} y1={y(t)} y2={y(t)} stroke="#f3f4f6" strokeDasharray="3 2" />
            <text x={-5} y={y(t)} dy="0.32em" textAnchor="end" fontSize={8} fill="#9ca3af">{t}</text>
          </g>
        ))}
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={iH + 12} textAnchor="middle" fontSize={8} fill="#9ca3af">
            {shortMonth(months[i])}
          </text>
        ))}
        {bPath && <path d={bPath} fill="none" stroke={B_COLOR} strokeWidth={1.8} strokeLinejoin="round" />}
        {aPath && <path d={aPath} fill="none" stroke={A_COLOR} strokeWidth={2.2} strokeLinejoin="round" />}
      </g>
    </svg>
  );
};

/** A single drop zone (A or B) with its member chips. */
const DropZone: React.FC<{
  side: CompareSide;
  color: string;
  agg: SideAgg;
  onRemove: (item: SelectedItem) => void;
}> = ({ side, color, agg, onRemove }) => {
  const { addToCompare, triggerFlyTo } = useHotspotStore();
  const [over, setOver] = useState(false);

  return (
    <div
      className={"cmpb__zone" + (over ? " cmpb__zone--over" : "")}
      style={{ borderTopColor: color }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const k = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
        if (!k) return;
        const [month, rankStr] = k.split("|");
        if (month && rankStr) addToCompare(side, { month, rank: Number(rankStr) });
      }}
    >
      <div className="cmpb__zone-head">
        <span className="cmpb__zone-tag" style={{ background: color }}>{side}</span>
        <span className="cmpb__zone-total" style={{ color }}>
          {agg.crimes.toLocaleString()}
        </span>
        <span className="cmpb__zone-sub">
          delitos · {agg.members.length} {agg.members.length === 1 ? "zona" : "zonas"}
        </span>
      </div>

      {agg.members.length === 0 ? (
        <p className="cmpb__zone-empty">Suelta aquí un subgrafo</p>
      ) : (
        <ul className="cmpb__chips">
          {agg.members.map(({ item, spot }) => (
            <li key={`${item.month}-${item.rank}`} className="cmpb__chip">
              <button
                type="button"
                className="cmpb__chip-go"
                onClick={() => { if (spot.center) triggerFlyTo(spot.center[0], spot.center[1]); }}
                title="Ir a su ubicación en el mapa"
                disabled={!spot.center}
              >
                <SubgraphGlyph spot={spot} size={22} muted />
                <span className="cmpb__chip-id">
                  #{item.rank}
                  <span className="cmpb__chip-month">{formatMonth(item.month)}</span>
                </span>
              </button>
              <button
                type="button"
                className="cmpb__chip-x"
                onClick={() => onRemove(item)}
                title="Quitar de la comparación"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ComparisonBuilder: React.FC = () => {
  const { compareA, compareB, removeFromCompare, clearCompare } = useHotspotStore();
  const { data } = useHotspots();

  const months = useMemo(() => (data ? Object.keys(data).sort() : []), [data]);

  const aAgg = useMemo(() => aggregateSide(compareA, data, months.length), [compareA, data, months.length]);
  const bAgg = useMemo(() => aggregateSide(compareB, data, months.length), [compareB, data, months.length]);

  const crimeRows = useMemo(
    () => pairedRows(aAgg.crimeTypes, bAgg.crimeTypes, crimeLabel, crimeColor),
    [aAgg, bAgg],
  );
  const poiRows = useMemo(
    () => pairedRows(aAgg.poiTypes, bAgg.poiTypes, poiLabel, poiColor),
    [aAgg, bAgg],
  );

  const hasA = aAgg.members.length > 0;
  const hasB = bAgg.members.length > 0;
  const both = hasA && hasB;

  const crimeMax = Math.max(...crimeRows.map((r) => Math.max(r.a, r.b)), 1);
  const poiMax = Math.max(...poiRows.map((r) => Math.max(r.a, r.b)), 1);

  const delta = bAgg.crimes - aAgg.crimes;
  const deltaPct = aAgg.crimes > 0 ? Math.round((100 * delta) / aAgg.crimes) : 0;
  const headline =
    delta === 0
      ? "Misma cantidad de delitos"
      : delta < 0
        ? `B tiene ${Math.abs(deltaPct)}% menos delitos que A`
        : `B tiene ${deltaPct}% más delitos que A`;

  return (
    <div className="cmpb">
      <div className="cmpb__header">
        <span className="cmpb__title">Comparación A vs B</span>
        {(hasA || hasB) && (
          <button className="cmpb__clear" onClick={clearCompare} title="Vaciar A y B">
            Limpiar
          </button>
        )}
      </div>

      <div className="cmpb__zones">
        <DropZone side="A" color={A_COLOR} agg={aAgg} onRemove={(it) => removeFromCompare("A", it)} />
        <DropZone side="B" color={B_COLOR} agg={bAgg} onRemove={(it) => removeFromCompare("B", it)} />
      </div>

      {!hasA && !hasB && (
        <p className="cmpb__hint">
          Arrastra subgrafos desde la lista de la izquierda hasta las zonas A y B.
          Puedes soltar varios en un mismo lado: sus datos se suman.
        </p>
      )}

      {both && (
        <div className={"compare-panel__headline" + (delta < 0 ? " compare-panel__headline--down" : "")}>
          {headline}
        </div>
      )}

      {(hasA || hasB) && (aAgg.history || bAgg.history) && (
        <>
          <div className="compare-panel__section-label">Evolución del footprint · A | B</div>
          <SummedHistory months={months} a={aAgg.history} b={bAgg.history} />
        </>
      )}

      {(hasA || hasB) && (
        <>
          <div className="compare-panel__section-label">Tipos de delito · A | B</div>
          <div className="compare-panel__rows">
            {crimeRows.map((r) => (
              <PairedBar key={r.key} row={r} max={crimeMax} />
            ))}
          </div>

          <div className="compare-panel__section-label">POIs (uso de suelo) · A | B</div>
          {poiRows.length === 0 ? (
            <p className="compare-panel__empty">Ninguna zona tiene POIs registrados</p>
          ) : (
            <div className="compare-panel__rows">
              {poiRows.map((r) => (
                <PairedBar key={r.key} row={r} max={poiMax} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ComparisonBuilder;
