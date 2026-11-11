import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// The built site is uploaded by hand to a GitHub Pages branch, so it has to work from any folder
// (https://user.github.io/repo/ or a custom domain root) with no build-time knowledge of where it
// lives. Hence the relative base, and settings in a plain config.js instead of env vars.

// GitHub Pages cannot send response headers, so the Content-Security-Policy is a <meta> tag in
// every built page. Build only: the dev server needs inline scripts for hot reload.
// (frame-ancestors is ignored in <meta>, so it is left out. See README, "Security notes".)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  'child-src blob:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const cspMeta = (): Plugin => ({
  name: 'tacmap-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

const page = (name: string) => resolve(import.meta.dirname, name);

// Separate entry points on purpose: the viewer bundle (view.html) and the player bundle (play.html)
// contain no editor code at all.
export default defineConfig({
  base: './',
  plugins: [react(), cspMeta()],
  build: {
    outDir: 'dist',  // scripts/release.mjs copies it to the repository root
    emptyOutDir: true,
    rollupOptions: {
      input: { main: page('index.html'), view: page('view.html'), play: page('play.html') },
      // No file may start with "_" or ".": GitHub Pages (Jekyll) silently drops those unless .nojekyll
      // made it through the upload, and drag-and-drop tends to skip hidden files.
      output: { entryFileNames: 'assets/e-[name]-[hash].js', chunkFileNames: 'assets/c-[name]-[hash].js', 
        // The MapLibre worker is emitted as .mjs; serve it as .js so every static host sends a JavaScript MIME type.
        assetFileNames: (info) => (info.names?.[0]?.endsWith('.mjs') ? 'assets/a-[name]-[hash].js' : 'assets/a-[name]-[hash][extname]'),
      },
    },
  },
  test: { environment: 'node', testTimeout: 60_000, hookTimeout: 60_000 },
});
