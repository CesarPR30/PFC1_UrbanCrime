import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (served from https://<user>.github.io/<repo>/) regardless of repo name.
  base: "./",
  plugins: [react()],
});
