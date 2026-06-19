import React, { useMemo } from "react";
import { useHotspotStore } from "../store/useHotspotStore";
import { useHotspots } from "../hooks/useHotspots";
import SubgraphGlyph from "./SubgraphGlyph";
import type { Hotspot } from "../hooks/useHotspots";
import type { SelectedItem } from "../store/useHotspotStore";

/**
 * CandidateList — the pool of subgraphs available to compare, shown in the left
 * sidebar under the UMAP.
 *
 * It lists either the topologically similar subgraphs of the current reference
 * (plus the reference itself) or, when a lasso is active, the lassoed set. Every
 * row is draggable: drop it onto the A or B zone of the comparison builder in
 * the right panel to add it to that side. The DnD payload is just the
 * "month|rank" key, read back by the drop zone.
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
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const keyOf = (it: SelectedItem) => `${it.month}|${it.rank}`;

export const DRAG_MIME = "application/x-subgraph";

interface Candidate {
  item: SelectedItem;
  spot: Hotspot;
  similarity?: number;
  isRef?: boolean;
}

const CandidateList: React.FC = () => {
  const {
    selectedItem, lassoSelection, triggerFlyTo, addToCompare,
  } = useHotspotStore();
  const { data } = useHotspots();

  const { mode, candidates } = useMemo<{
    mode: "ref" | "lasso" | "none";
    candidates: Candidate[];
  }>(() => {
    if (!data) return { mode: "none", candidates: [] };
    const resolve = (it: SelectedItem) =>
      data[it.month]?.find((s) => s.rank === it.rank) ?? null;

    if (lassoSelection.length > 0) {
      const candidates = lassoSelection
        .map((it): Candidate | null => {
          const spot = resolve(it);
          return spot ? { item: it, spot } : null;
        })
        .filter((c): c is Candidate => c != null);
      return { mode: "lasso", candidates };
    }

    if (selectedItem) {
      const ref = resolve(selectedItem);
      if (!ref) return { mode: "none", candidates: [] };
      const sims = (ref.similarTo ?? [])
        .map((s): Candidate | null => {
          const it = { month: s.month, rank: s.rank };
          const spot = resolve(it);
          return spot ? { item: it, spot, similarity: s.similarity } : null;
        })
        .filter((c): c is Candidate => c != null);
      return {
        mode: "ref",
        candidates: [{ item: selectedItem, spot: ref, isRef: true }, ...sims],
      };
    }

    return { mode: "none", candidates: [] };
  }, [data, selectedItem, lassoSelection]);

  if (mode === "none") return null;

  const heading =
    mode === "lasso"
      ? `Zonas del lazo · ${candidates.length}`
      : "Referencia + topología parecida";

  return (
    <div className="candidates">
      <div className="candidates__header">
        <span className="candidates__title">{heading}</span>
        <span className="candidates__hint">arrastra a A / B →</span>
      </div>

      <ul className="candidates__list">
        {candidates.map((c, i) => {
          // "R" for the reference, then "A", "B", … for the similars in order —
          // the same letters used on the timeline markers. Only in reference mode.
          const letter =
            mode === "ref" ? (i === 0 ? "R" : String.fromCharCode(64 + i)) : null;
          return (
          <li
            key={keyOf(c.item)}
            className={"candidates__item" + (c.isRef ? " candidates__item--ref" : "")}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, keyOf(c.item));
              e.dataTransfer.setData("text/plain", keyOf(c.item));
              e.dataTransfer.effectAllowed = "copy";
            }}
            title="Arrastra a la zona A o B · clic para ir a su ubicación en el mapa"
            onClick={() => {
              // Only navigate to its location — do not change the reference, so
              // the similar list (and the selected subgraph) stays put.
              if (c.spot.center) triggerFlyTo(c.spot.center[0], c.spot.center[1]);
            }}
          >
            {letter && (
              <span
                className={
                  "candidates__letter" +
                  (c.isRef ? " candidates__letter--ref" : " candidates__letter--sim")
                }
                aria-hidden
              >
                {letter}
              </span>
            )}
            <span className="candidates__grip" aria-hidden>⠿</span>
            <SubgraphGlyph spot={c.spot} size={34} muted={!c.isRef} />
            <span className="candidates__info">
              <span className="candidates__rank">
                #{c.item.rank}
                {c.isRef && <em className="candidates__ref-tag">ref</em>}
              </span>
              <span className="candidates__month">{formatMonth(c.item.month)}</span>
              <span className="candidates__crimes">{c.spot.crimes} delitos</span>
            </span>
            {c.similarity != null && (
              <span className="candidates__sim" title="Similitud topológica">
                {pct(c.similarity)}
              </span>
            )}
            <span className="candidates__add">
              <button
                type="button"
                className="candidates__add-btn candidates__add-btn--a"
                onClick={(e) => { e.stopPropagation(); addToCompare("A", c.item); }}
                title="Añadir al lado A"
              >
                A
              </button>
              <button
                type="button"
                className="candidates__add-btn candidates__add-btn--b"
                onClick={(e) => { e.stopPropagation(); addToCompare("B", c.item); }}
                title="Añadir al lado B"
              >
                B
              </button>
            </span>
          </li>
          );
        })}
      </ul>
    </div>
  );
};

export default CandidateList;
