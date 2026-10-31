/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Scout backend. Today it is the Next app on port 4240 serving /v1 and /api/auth.
const backend = process.env.SCOUT_BACKEND_URL ?? 'http://localhost:4240';

// The backend's CSRF check compares Origin with APP_PUBLIC_URL (the backend's own origin), so the
// proxy sends the backend origin instead of the Vite one. See README.md.
const toBackend = {
  target: backend,
  changeOrigin: true,
  configure: (proxy: { on: (event: 'proxyReq', fn: (req: { getHeader(n: string): unknown; setHeader(n: string, v: string): void }) => void) => void }) => {
    proxy.on('proxyReq', (req) => {
      if (req.getHeader('origin')) req.setHeader('origin', new URL(backend).origin);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  // Inline, so Vite does not pick up the backend's PostCSS and Tailwind config from the repo root.
  css: { postcss: { plugins: [] } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/v1': toBackend, '/api': toBackend, '/healthz': toBackend },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
