/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Vitest config for the webui (dev-only). Kept SEPARATE from `vite.config.ts`
 * (the production build config) so the build path is untouched. Runs component
 * tests in jsdom with the React plugin and the jest-dom setup.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
