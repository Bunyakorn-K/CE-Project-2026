import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite as tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

// VITE_LIFF_ID is passed as a Docker build-arg, but `envDir` points at the
// repo root where no .env defines it — so `import.meta.env.VITE_LIFF_ID`
// resolves to undefined and the minifier deletes every LIFF branch from the
// bundle. Define it explicitly so the value is baked in at build time.
const liffId = process.env.VITE_LIFF_ID ?? "";

export default defineConfig({
  envDir: "../..",
  define: {
    "import.meta.env.VITE_LIFF_ID": JSON.stringify(liffId)
  },
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