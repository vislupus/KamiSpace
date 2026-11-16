import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The bundle is written to ../static/dist and served by FastAPI. There is no
// dev server: `npm run dev` rebuilds on change, the backend serves the result.
// KaTeX ships every font as woff2, woff and ttf. All supported browsers read
// woff2, so the other two formats are dropped from its stylesheet (and so from
// the bundle) instead of adding forty unused files to the repository.
const katexWoff2Only = {
  name: 'katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('katex') || !id.split('?')[0].endsWith('.css')) return null;
    return code.replace(
      /,url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
      '',
    );
  },
};

export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  base: '/static/dist/',
  publicDir: false,
  plugins: [katexWoff2Only],
  build: {
    outDir: resolve(import.meta.dirname, '../static/dist'),
    emptyOutDir: true,
    manifest: true,
    // Never inline assets as data: URIs — the Content-Security-Policy only
    // allows fonts and images served by this server.
    assetsInlineLimit: 0,
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
