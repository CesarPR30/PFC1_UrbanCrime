import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("mapbox-gl")) return "vendor-map";
          if (id.includes("leaflet")) return "vendor-leaflet";
          if (id.includes("/d3") || id.includes("/d3-")) return "vendor-d3";
          if (id.includes("deck.gl") || id.includes("@deck.gl")) return "vendor-deck";
          if (id.includes("recharts") || id.includes("victory-vendor")) return "vendor-recharts";
          if (id.includes("react-dom") || id.includes("react-is")) return "vendor-react";
          if (id.includes("/react/")) return "vendor-react";
        },
      },
    },
  },
});
