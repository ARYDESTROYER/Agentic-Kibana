import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-ignore - CJS plugin module
import euiIconsPlugin from './vite-plugin-eui-icons.cjs';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8088';

export default defineConfig({
  plugins: [react(), euiIconsPlugin()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    host: '0.0.0.0',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
