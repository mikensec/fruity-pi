import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const target = process.env.FRUITY_PI_URL ?? "http://127.0.0.1:7777";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, "dist"), emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
});
