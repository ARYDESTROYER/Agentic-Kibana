import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8088';

function fixEuiIconPaths() {
  return {
    name: 'fix-eui-icon-paths',
    transform(_code: string, id: string) {
      if (id.includes('@elastic/eui') && id.includes('/icon/icon.')) {
        return {
          code: _code.replace("'./assets/'", "'/assets/'"),
          map: null,
        };
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    fixEuiIconPaths(),
    {
      name: 'copy-eui-icons',
      closeBundle() {
        const src = join(__dirname, 'node_modules/@elastic/eui/es/components/icon/assets');
        const dest = join(__dirname, 'dist/assets');
        try { mkdirSync(dest, { recursive: true }); } catch {}
        for (const file of readdirSync(src)) {
          if (file.endsWith('.js')) {
            copyFileSync(join(src, file), join(dest, file));
          }
        }
      },
    },
  ],
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
