import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import {
  BUNDLED_DOCUMENTATION,
  resolveDocumentationAlias,
  resolveDocumentationDirectory,
} from './docs.config';
import { resolveBuildReleaseIdentity } from './release.config';

/**
 * Vite config for Agentic SOC.
 *
 * In dev, the SPA is served on :5173 and all `/api/*` calls are proxied to the
 * FastAPI backend on :8088, so the browser talks to the backend DIRECTLY (there
 * is no Kibana proxy in the standalone deployment). Set `BACKEND_URL` to point at
 * a different backend during development.
 */
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8088';
const RELEASE_IDENTITY = resolveBuildReleaseIdentity();
const DEV_DOCS_ROOT = path.resolve(__dirname, 'public/docs');
const PREVIEW_DOCS_ROOT = path.resolve(__dirname, 'dist/docs');

function docsRequestBoundary(docsRoot: string): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (!request.url) return next();
    const requestUrl = new URL(request.url, 'http://tlsoc.local');
    if (requestUrl.pathname !== '/docs' && !requestUrl.pathname.startsWith('/docs/')) {
      return next();
    }

    const alias = resolveDocumentationAlias(requestUrl.pathname, BUNDLED_DOCUMENTATION);
    if (alias) {
      response.statusCode = 307;
      response.setHeader('Location', `${alias}${requestUrl.search}${requestUrl.hash}`);
      response.end();
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname.slice('/docs/'.length));
    } catch {
      response.statusCode = 400;
      response.end('Malformed documentation path');
      return;
    }
    const candidate = path.resolve(docsRoot, decodedPath);
    const insideDocs = candidate === docsRoot || candidate.startsWith(`${docsRoot}${path.sep}`);
    if (!insideDocs) {
      response.statusCode = 400;
      response.end('Malformed documentation path');
      return;
    }

    const exists = fs.existsSync(candidate);
    const isDirectory = exists && fs.statSync(candidate).isDirectory();
    const directoryIndex = isDirectory ? path.join(candidate, 'index.html') : undefined;
    if (directoryIndex && fs.existsSync(directoryIndex)) {
      const directoryRequest = resolveDocumentationDirectory(requestUrl.pathname);
      if (directoryRequest.kind === 'redirect') {
        response.statusCode = 307;
        response.setHeader(
          'Location',
          `${directoryRequest.path}${requestUrl.search}${requestUrl.hash}`,
        );
        response.end();
        return;
      }
      // Vite's history fallback treats a directory URL as a React route even
      // when that directory contains index.html. Point its static middleware at
      // the concrete MkDocs file so `/docs/<line>/.../` cannot become the SPA.
      request.url = `${directoryRequest.path}${requestUrl.search}`;
      return next();
    }
    if (exists && !isDirectory) return next();

    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Documentation page not found');
  };
}

function bundledDocumentationPlugin(): Plugin {
  return {
    name: 'tlsoc-bundled-documentation',
    configureServer(server) {
      server.middlewares.use(docsRequestBoundary(DEV_DOCS_ROOT));
    },
    configurePreviewServer(server) {
      server.middlewares.use(docsRequestBoundary(PREVIEW_DOCS_ROOT));
    },
  };
}

export default defineConfig({
  plugins: [bundledDocumentationPlugin(), react()],
  define: {
    __TLSOC_RELEASE_IDENTITY__: JSON.stringify(RELEASE_IDENTITY),
  },
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
          // clsx / tailwind-merge back the entry's cn() helper AND are a transitive
          // dependency of recharts. They MUST get their own tiny, stable chunk
          // BEFORE the recharts branch — otherwise Rollup co-locates clsx into the
          // recharts chunk, and the eager cn() then statically imports recharts,
          // dragging all 422 KB onto first paint. Splitting them out keeps recharts
          // reachable ONLY through the React.lazy chart pages.
          if (/[\\/]node_modules[\\/](clsx|tailwind-merge)[\\/]/.test(id))
            return 'utils';
          // recharts pulls in d3-* — keep it isolated so chart-heavy pages pay
          // for it only when they load.
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-vendor|internmap|decimal\.js-light)/.test(id))
            return 'recharts';
          // motion.dev (the framer-motion successor, npm package `motion`) — route it
          // into its own lazy `motion` chunk. Match the package's OWN node_modules path
          // (not a loose `id.includes('motion')`, which would also catch unrelated
          // paths). The bundle-first-paint test asserts this chunk is emitted but is
          // NEVER modulepreloaded / statically imported by the entry (motion lives behind
          // the lazy `soc/components/motion/*` boundary).
          if (/[\\/]node_modules[\\/]motion[\\/]/.test(id)) return 'motion';
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
