import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * `/api` and the verification page's assets are proxied rather than hard-coded
 * into a base URL, so the app is same-origin in development exactly as it is in
 * production — where §16 serves this build from the API process itself. A
 * `VITE_API_URL` would be a second deployment topology to keep working for no
 * gain.
 *
 * `/core` and `/vendor` are on the list because /verify.html imports the engine
 * source and seedrandom from the API's static mounts. Vite serves the page
 * itself out of `public/`, so without these the sidebar's "Verify a cycle" link
 * opens a page whose scripts 404 — broken in dev, working in production, which
 * is the worst way round.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    proxy: {
      '/api': { target: process.env.API_URL || 'http://127.0.0.1:4000', changeOrigin: true },
      '/verify.html': { target: process.env.API_URL || 'http://127.0.0.1:4000' },
      '/core': { target: process.env.API_URL || 'http://127.0.0.1:4000' },
      '/vendor': { target: process.env.API_URL || 'http://127.0.0.1:4000' },
    },
  },
});
