import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The bundle is written to ../static/dist and served by FastAPI. There is no
// dev server: `npm run dev` rebuilds on change, the backend serves the result.
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  base: '/static/dist/',
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, '../static/dist'),
    emptyOutDir: true,
    manifest: true,
    target: 'es2022',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/main.js'),
        auth: resolve(import.meta.dirname, 'src/auth.js'),
      },
    },
  },
}));
