import { useState, useEffect } from "react";

export interface SimilarHotspot {
  month: string;
  rank: number;
  similarity: number;
}

export interface PoiEntry {
  lat: number;
  lng: number;
  category: string;
}

export interface Hotspot {
  rank: number;
  crimes: number;
  peakCrimes: number;
  center: [number, number] | null;
  nodes: [number, number][];
  edges: [[number, number], [number, number]][];
  crimeTypes: Record<string, number>;
  /** Count of basin edges per road class (expressway / avenue / collector / street / …). */
  roadTypes: Record<string, number>;
  similarTo: SimilarHotspot[];
  pois: PoiEntry[];
  poiTypes: Record<string, number>;
  /**
   * 2-D UMAP projection of the subgraph's embedding (topology + road class),
   * each axis min-max scaled to [0, 1]. This is the default/primary space.
   * Computed offline by preprocess_hotspots.py / embed_subgraphs.py.
   */
  embed2d?: [number, number];
  /** UMAP of the topology block only (NetLSD + geometry, no road class). */
  embedTopo?: [number, number];
  /**
   * Monthly crime counts at this basin's footprint across the whole study
   * window, aligned with the sorted month keys of the dataset.
   */
  history?: number[];
}

/** Month key "YYYY-MM" → ordered array of up to 20 hotspots */
export type HotspotsData = Record<string, Hotspot[]>;

export function useHotspots() {
  const [data, setData] = useState<HotspotsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}hotspots.json`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<HotspotsData>;
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
