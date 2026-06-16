import { create } from "zustand";

export interface SelectedItem {
  month: string;
  rank: number;
}

/** Which side of the drag-and-drop comparison a subgraph is dropped into. */
export type CompareSide = "A" | "B";

interface FlyTarget {
  lat: number;
  lng: number;
  ts: number;
}

interface HotspotState {
  selectedItem: SelectedItem | null;
  /** Comparison target: a (usually similar) subgraph compared side-by-side
   *  against `selectedItem` in the sidebar. */
  compareItem: SelectedItem | null;
  /** Multi-selection drawn with the UMAP lasso tool ("month|rank" items). */
  lassoSelection: SelectedItem[];
  /** Drag-and-drop comparison: each side holds one or more subgraphs whose
   *  data are summed together; A is contrasted against B in the right panel. */
  compareA: SelectedItem[];
  compareB: SelectedItem[];
  flyTarget: FlyTarget | null;
  setSelectedItem: (item: SelectedItem | null) => void;
  setCompareItem: (item: SelectedItem | null) => void;
  setLassoSelection: (items: SelectedItem[]) => void;
  addToCompare: (side: CompareSide, item: SelectedItem) => void;
  removeFromCompare: (side: CompareSide, item: SelectedItem) => void;
  clearCompare: () => void;
  triggerFlyTo: (lat: number, lng: number) => void;
}

const sameItem = (a: SelectedItem, b: SelectedItem) =>
  a.month === b.month && a.rank === b.rank;

export const useHotspotStore = create<HotspotState>((set) => ({
  selectedItem: null,
  compareItem: null,
  lassoSelection: [],
  compareA: [],
  compareB: [],
  flyTarget: null,
  // Single-select and lasso-select are mutually exclusive: picking one point
  // clears the lasso set, and drawing a lasso clears the single selection.
  // Changing the reference subgraph also resets any side-by-side comparison.
  setSelectedItem: (item) =>
    set({ selectedItem: item, lassoSelection: [], compareItem: null }),
  setCompareItem: (item) => set({ compareItem: item }),
  setLassoSelection: (items) =>
    set((state) => ({
      lassoSelection: items,
      selectedItem: items.length ? null : state.selectedItem,
      compareItem: items.length ? null : state.compareItem,
    })),
  // Drop into a side: a subgraph lives in at most one side, so adding it to one
  // removes any prior copy from both sides first (no duplicates, no double-count).
  addToCompare: (side, item) =>
    set((state) => {
      const a = state.compareA.filter((x) => !sameItem(x, item));
      const b = state.compareB.filter((x) => !sameItem(x, item));
      return side === "A"
        ? { compareA: [...a, item], compareB: b }
        : { compareA: a, compareB: [...b, item] };
    }),
  removeFromCompare: (side, item) =>
    set((state) =>
      side === "A"
        ? { compareA: state.compareA.filter((x) => !sameItem(x, item)) }
        : { compareB: state.compareB.filter((x) => !sameItem(x, item)) },
    ),
  clearCompare: () => set({ compareA: [], compareB: [] }),
  triggerFlyTo: (lat, lng) => set({ flyTarget: { lat, lng, ts: Date.now() } }),
}));
