import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy the admin read APIs to a locally-running gateway so the app can
// use a same-origin base URL (no CORS). In prod, point the app at your gateway.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/traces': 'http://localhost:8080',
      '/regression': 'http://localhost:8080',
    },
  },
  preview: { port: 4173 },
});
