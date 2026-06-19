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
   * 2-D UMAP projections of the subgraph's road sub-network under four modern
   * whole-graph embedding techniques (each axis min-max scaled to [0, 1]).
   * Computed offline by preprocess_hotspots.py / embed_subgraphs.py.
   *   embedGL2Vec  – GL2Vec (Chen & Koga, ICONIP 2019): graph2vec(G) ⊕ graph2vec(L(G)).
   *   embedFeather – FEATHER-G (Rozemberczki & Sarkar, CIKM 2020): characteristic
   *                  functions over random walks.
   *   embedDHCE    – DHC-E (Wang et al., 2022): entropy of the Degree→H-index→
   *                  Coreness chain (hyperparameter-free).
   *   embedGCN     – GCN (Kipf & Welling, 2017): the ST-GCN spatial embedding of
   *                  Fan, Hu & Hu (2025); graph convolution + mean-pool.
   */
  embedGL2Vec?: [number, number];
  embedFeather?: [number, number];
  embedDHCE?: [number, number];
  embedGCN?: [number, number];
  /**
   * HDBSCAN cluster label of this subgraph within each technique's 2-D UMAP
   * layout (−1 = noise). Computed offline alongside the embeddings so the
   * painted clusters match exactly what each scatter shows.
   */
  clusterGL2Vec?: number;
  clusterFeather?: number;
  clusterDHCE?: number;
  clusterGCN?: number;
  /**
   * Legacy spaces, still emitted for parity but no longer shown on the page:
   * embed2d = topology + road class, embedTopo = topology only (NetLSD + geometry).
   */
  embed2d?: [number, number];
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
