import React, { useMemo } from "react";
import SubgraphGlyph from "./SubgraphGlyph";
import HistoryPanel from "./HistoryPanel";
import type { SeriesEntry } from "./HistoryPanel";
import { crimeColor, crimeLabel, poiColor, poiLabel } from "../theme";

/**
 * ComparePanel — side-by-side comparison of two subgraphs.
 *
 * This is the core interaction of the paper's comparative design: the user
 * picks a reference subgraph (A) and one of its topologically similar peers
 * (B), and the panel contrasts the *outcome* (crimes: total, delta, monthly
 * history) against the *context* (POI land-use mix), so differences in crime
 * between structurally alike zones can be read against differences in urban
 * function — e.g. "B se parece a A pero tiene menos delitos, y B tiene bancos".
 *
 * POI categories present in only one of the two zones are flagged explicitly
 * ("solo aquí"), because exclusive amenities are the most direct candidate
 * explanation for a crime gap between twins.
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

const A_COLOR = "#FE550B";
const B_COLOR = "#ffbfa3";

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
    .map((k) => ({
      key: k,
      label: labelFn(k),
      color: colorFn(k),
      a: aCounts[k] ?? 0,
      b: bCounts[k] ?? 0,
    }))
    .sort((r1, r2) => Math.max(r2.a, r2.b) - Math.max(r1.a, r1.b));
}

/** One mirrored bar row: A grows leftwards, B grows rightwards. */
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

interface Props {
  months: string[];
  a: SeriesEntry;
  b: SeriesEntry;
  similarity?: number;
  onClose: () => void;
}

const ComparePanel: React.FC<Props> = ({ months, a, b, similarity, onClose }) => {
  const crimeRows = useMemo(
    () => pairedRows(a.spot.crimeTypes ?? {}, b.spot.crimeTypes ?? {}, crimeLabel, crimeColor),
    [a, b],
  );
  const poiRows = useMemo(
    () => pairedRows(a.spot.poiTypes ?? {}, b.spot.poiTypes ?? {}, poiLabel, poiColor),
    [a, b],
  );
  const crimeMax = Math.max(...crimeRows.map((r) => Math.max(r.a, r.b)), 1);
  const poiMax = Math.max(...poiRows.map((r) => Math.max(r.a, r.b)), 1);

  // Crime gap headline: how B's volume compares against A's.
  const delta = b.spot.crimes - a.spot.crimes;
  const deltaPct = a.spot.crimes > 0 ? Math.round((100 * delta) / a.spot.crimes) : 0;
  const headline =
    delta === 0
      ? "Misma cantidad de delitos"
      : delta < 0
        ? `B tiene ${Math.abs(deltaPct)}% menos delitos que A`
        : `B tiene ${deltaPct}% más delitos que A`;

  return (
    <div className="compare-panel">
      <div className="compare-panel__header">
        <span className="compare-panel__title">
          Comparación A vs B
          {similarity != null && (
            <span className="compare-panel__similarity">
              · topología {Math.round(similarity * 100)}% similar
            </span>
          )}
        </span>
        <button
          className="compare-panel__close"
          onClick={onClose}
          title="Cerrar comparación"
        >
          ×
        </button>
      </div>

      {/* Side-by-side identity cards */}
      <div className="compare-panel__cards">
        {[
          { tag: "A", entry: a, color: A_COLOR },
          { tag: "B", entry: b, color: B_COLOR },
        ].map(({ tag, entry, color }) => (
          <div key={tag} className="compare-panel__card" style={{ borderTopColor: color }}>
            <div className="compare-panel__card-head">
              <span className="compare-panel__card-tag" style={{ background: color }}>
                {tag}
              </span>
              <SubgraphGlyph spot={entry.spot} size={40} />
            </div>
            <span className="compare-panel__card-id">
              #{entry.item.rank} · {formatMonth(entry.item.month)}
            </span>
            <span className="compare-panel__card-crimes" style={{ color }}>
              {entry.spot.crimes.toLocaleString()}
            </span>
            <span className="compare-panel__card-sub">delitos</span>
            <span className="compare-panel__card-meta">
              {entry.spot.nodes.length} nodos · {(entry.spot.pois ?? []).length} POIs
            </span>
          </div>
        ))}
      </div>

      <div className={"compare-panel__headline" + (delta < 0 ? " compare-panel__headline--down" : "")}>
        {headline}
      </div>

      {/* Footprint history of both zones (plus the reference's marker months) */}
      <HistoryPanel months={months} selected={a} compare={b} similars={[]} />

      <div className="compare-panel__section-label">Tipos de delito · A | B</div>
      <div className="compare-panel__rows">
        {crimeRows.map((r) => (
          <PairedBar key={r.key} row={r} max={crimeMax} />
        ))}
      </div>

      <div className="compare-panel__section-label">POIs (uso de suelo) · A | B</div>
      {poiRows.length === 0 ? (
        <p className="compare-panel__empty">Ninguna de las dos zonas tiene POIs registrados</p>
      ) : (
        <div className="compare-panel__rows">
          {poiRows.map((r) => (
            <PairedBar key={r.key} row={r} max={poiMax} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ComparePanel;
