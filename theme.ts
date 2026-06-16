/**
 * theme.ts — single source of truth for the dashboard's colour language.
 *
 * Goal (light theme): every crime type and every POI category keeps ONE colour
 * across the map, the pie/bar charts and the UMAP scatter, so a colour always
 * means the same thing wherever the eye lands. The crime palette is a
 * qualitative, well-separated hue set (orange / blue / purple / teal) that
 * stays legible on a white background and is reasonably colour-blind friendly.
 */

// ─── Crime types ──────────────────────────────────────────────────────────────

/** Canonical order — drives legend ordering and chart colour assignment. */
export const CRIME_ORDER = [
  "THEFT",
  "ASSAULT",
  "MOTOR VEHICLE THEFT",
  "ROBBERY",
] as const;

/** Crime type → hex. Used by every component that paints a crime type. */
export const CRIME_COLORS: Record<string, string> = {
  THEFT: "#F4511E", // deep orange — aligned with the brand crime colour
  ASSAULT: "#1E88E5", // blue
  "MOTOR VEHICLE THEFT": "#8E24AA", // purple
  ROBBERY: "#00897B", // teal
};

/** Spanish display labels for crime types (UI is in Spanish). */
export const CRIME_LABEL: Record<string, string> = {
  THEFT: "Hurto",
  ASSAULT: "Asalto",
  "MOTOR VEHICLE THEFT": "Robo de vehículo",
  ROBBERY: "Robo con violencia",
};

/** Colour for any crime type not in the map above. */
export const CRIME_FALLBACK = "#94A3B8"; // slate-400

export function crimeColor(type: string): string {
  return CRIME_COLORS[type] ?? CRIME_FALLBACK;
}

export function crimeLabel(type: string): string {
  return CRIME_LABEL[type] ?? type;
}

// ─── POI categories ───────────────────────────────────────────────────────────

export const POI_COLORS: Record<string, string> = {
  food: "#F59E0B", // amber
  nightlife: "#8B5CF6", // violet
  education: "#3B82F6", // blue
  health: "#EC4899", // pink
  police: "#1E40AF", // indigo
  finance: "#14B8A6", // teal
  retail: "#22C55E", // green
  park: "#16A34A", // dark green
  other: "#94A3B8", // slate
};

export const POI_LABEL: Record<string, string> = {
  food: "Alimentación",
  nightlife: "Vida nocturna",
  education: "Educación",
  health: "Salud",
  police: "Policía",
  finance: "Finanzas",
  retail: "Comercio",
  park: "Parques",
  other: "Otros",
};

export function poiColor(cat: string): string {
  return POI_COLORS[cat] ?? POI_COLORS.other;
}

export function poiLabel(cat: string): string {
  return POI_LABEL[cat] ?? cat;
}

// ─── Hotspot rank ramp (deep red → soft orange) ───────────────────────────────

/** Rank 1 (most crimes) → deep red; rank 20 → light orange. RGBA for deck.gl. */
export function hotspotColor(rank: number): [number, number, number, number] {
  const t = (rank - 1) / 19;
  return [
    Math.round(220 + t * 33),
    Math.round(38 + t * 148),
    Math.round(38 + t * 78),
    Math.round(230 - t * 90),
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "#RRGGBB" → [r, g, b] for deck.gl getColor accessors. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Pre-computed RGB triples for POI categories (deck.gl ScatterplotLayer). */
export const POI_RGB: Record<string, [number, number, number]> = Object.fromEntries(
  Object.entries(POI_COLORS).map(([k, v]) => [k, hexToRgb(v)]),
) as Record<string, [number, number, number]>;
