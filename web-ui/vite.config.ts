/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Scout backend: the server on port 4240 (`npm run dev` at the repo root) serving the API at /api/v1,
// sign-in at /api/auth and the health checks.
const backend = process.env.SCOUT_BACKEND_URL ?? 'http://localhost:4240';

type ProxyReq = { getHeader(n: string): unknown; setHeader(n: string, v: string): void };
type Incoming = { headers: { host?: string } };

// The backend's CSRF check compares Origin with APP_PUBLIC_URL (the backend's own origin), so the
// proxy sends the backend origin instead of the Vite one. Only an Origin that is this dev server's
// own (http://{the Host the browser asked}) is rewritten; any other Origin goes through untouched, so
// the backend still refuses it. See README.md.
const toBackend = {
  target: backend,
  changeOrigin: true,
  configure: (proxy: { on: (event: 'proxyReq', fn: (proxyReq: ProxyReq, req: Incoming) => void) => void }) => {
    proxy.on('proxyReq', (proxyReq, req) => {
      const devOrigin = req.headers.host ? `http://${req.headers.host}` : null;
      if (devOrigin && proxyReq.getHeader('origin') === devOrigin) proxyReq.setHeader('origin', new URL(backend).origin);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  // Inline and empty: the app is plain CSS modules, and Vite does not go looking for a PostCSS config in
  // parent folders.
  css: { postcss: { plugins: [] } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': toBackend, '/healthz': toBackend, '/readyz': toBackend },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
