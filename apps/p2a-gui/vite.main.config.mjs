import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    rollupOptions: {
      external: ["electron", "node-pty", "node:child_process", "node:crypto", "node:fs", "node:path"],
    },
  },
});
