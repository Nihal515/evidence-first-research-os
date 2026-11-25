import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// In local development the FastAPI backend runs on :8000; on Vercel it is
// served from the same origin under /api.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  preview: { proxy: { "/api": "http://127.0.0.1:8000" } },
  test: { environment: "node" },
});
