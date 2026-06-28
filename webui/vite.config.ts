import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vite config for the standalone Agentic SOC web UI.
 *
 * In dev, the SPA is served on :5173 and all `/api/*` calls are proxied to the
 * FastAPI backend on :8088, so the browser talks to the backend DIRECTLY (there
 * is no Kibana proxy in the standalone deployment). Set `BACKEND_URL` to point at
 * a different backend during development.
 */
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8088';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
});
