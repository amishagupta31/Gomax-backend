import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: the API runs on :8080 (cd ../backend && npm run dev:local); /v1 is proxied
// so the browser sees one origin. In production set VITE_API_URL to the API's URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/v1': 'http://127.0.0.1:8080' },
  },
});
