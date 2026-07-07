import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api → the REST API so the browser makes same-origin requests (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
