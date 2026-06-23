import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../.vite/renderer/main_window",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
