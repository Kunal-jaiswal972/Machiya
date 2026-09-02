import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // maplibre-gl loads its tile-parsing web worker as a separate entry. The dep
    // optimizer rewrites the main entry but drops the worker chunk, so the worker
    // 404s, no vector tiles are ever fetched, and the map renders as an empty
    // background with no error. Excluding it keeps maplibre's own worker wiring
    // intact. Do not "optimise" this away.
    exclude: ['maplibre-gl'],
  },
  server: {
    port: 5173,
    // Bind all interfaces so the container is reachable from the host.
    host: true,
    strictPort: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
  build: {
    sourcemap: true,
    // maplibre-gl is ~1 MB and unavoidable. It must NOT be forced into a manual
    // chunk: that severs it from its worker chunk, with the same silent blank-map
    // failure as above.
    chunkSizeWarningLimit: 1200,
  },
});
