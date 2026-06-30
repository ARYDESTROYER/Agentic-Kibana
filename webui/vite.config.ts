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
    rollupOptions: {
      output: {
        /**
         * Split heavy vendor libraries into their own long-lived, cacheable
         * chunks (Wave 0, foundation #6). Pairs with the per-page React.lazy
         * splits in App.tsx so the entry bundle no longer carries every page +
         * every vendor. Each entry returns a stable chunk name; anything else
         * falls through to Vite's default chunking.
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // recharts pulls in d3-* — keep it isolated so chart-heavy pages pay
          // for it only when they load.
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-vendor|internmap|decimal\.js-light)/.test(id))
            return 'recharts';
          if (id.includes('framer-motion')) return 'motion';
          if (id.includes('lucide-react')) return 'icons';
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) return 'radix';
          // react / react-dom (and the JSX runtime / scheduler) form the core.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|object-assign|use-sync-external-store)[\\/]/.test(id))
            return 'react-vendor';
          return undefined;
        },
      },
    },
  },
});
