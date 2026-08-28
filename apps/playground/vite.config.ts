import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787"
    }
  }
});
