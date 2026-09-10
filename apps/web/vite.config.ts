import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite as tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss()
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787"
    }
  }
});