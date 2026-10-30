import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: {
      "/ws": { target: "ws://localhost:4317", ws: true },
      "/data": { target: "ws://localhost:4317", ws: true },
      "/api": "http://localhost:4317",
      "/mcp": "http://localhost:4317",
    },
  },
});
