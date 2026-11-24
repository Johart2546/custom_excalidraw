import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // @excalidraw/excalidraw reads this at build time.
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:5002", "/scenes": "http://127.0.0.1:5002" },
  },
});
