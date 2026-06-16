import { useState, useEffect } from "react";

/** One road-network node that captured at least one crime. */
export interface CrimeNode {
  lat: number;
  lng: number;
  /** Total crimes snapped to this node across the whole study window. */
  n: number;
  /** Per-month breakdown ("YYYY-MM" → count) so the view can follow the date range. */
  m: Record<string, number>;
}

export interface NodesData {
  /** Busiest node's total — handy as a global reference. */
  max: number;
  months: string[];
  nodes: CrimeNode[];
}

/**
 * Loads `public/nodes.json` — the per-node crime counts produced by
 * build_nodes.py. Used by the "node crime map" view, which colours every street
 * node by how many crimes snapped to it (relative to the busiest node) so you
 * can validate that the corners are pulling crimes the way the heat-map shows.
 */
export function useNodes() {
  const [data, setData] = useState<NodesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}nodes.json`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<NodesData>;
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch(() => {
        setAvailable(false);
        setLoading(false);
      });
  }, []);

  return { data, loading, available };
}
