import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Serve the UI on the local network; the FastAPI service remains private
    // behind the /api proxy below.
    host: "0.0.0.0",
    port: 5180,
    proxy: {
      // Big SOG bodies stream through here; no timeout so a cold NAS read can't kill the load.
      "/api": { target: "http://127.0.0.1:8777", changeOrigin: true, timeout: 0 },
    },
  },
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
});
