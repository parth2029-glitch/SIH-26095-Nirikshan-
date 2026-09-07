import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * `/api` and `/verify.html` are proxied rather than hard-coded into a base URL,
 * so the app is same-origin in development exactly as it is in production —
 * where §16 serves this build from the API process itself. A `VITE_API_URL`
 * would be a second deployment topology to keep working for no gain.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    proxy: {
      '/api': { target: process.env.API_URL || 'http://127.0.0.1:4000', changeOrigin: true },
      '/verify.html': { target: process.env.API_URL || 'http://127.0.0.1:4000' },
    },
  },
});
