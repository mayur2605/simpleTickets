import { defineConfig } from "vite";

/**
 * In production the server serves this bundle itself, so /api is same-origin
 * and nothing needs proxying. This proxy exists only for `npm run dev`, where
 * Vite is on 5173 and the server is on 8787 — it makes the dev setup behave
 * like production, so the session cookie works and no CORS is involved.
 *
 * When no server is running the proxy fails, api.ts treats that as "no
 * backend", and the dashboard falls back to sample data. That is what keeps the
 * browser smoke test working without a database.
 */
export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: process.env["VITE_PROXY_TARGET"] ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
