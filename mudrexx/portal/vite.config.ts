import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The portal is always served SAME-ORIGIN with the API.
 *
 * This is not a preference — it is required. The MUDREXX session cookie is
 * HttpOnly + `SameSite=Strict` (see src/routes/session-cookie.ts), so a browser
 * will not attach it to cross-site requests. A portal on foo.vercel.app calling
 * bar.workers.dev directly would authenticate exactly once and then silently
 * fail every subsequent request.
 *
 * In development that is solved by the proxy below; in production by the
 * /api/[...path] rewrite (see ../../vercel.json and ../../api/[...path].ts).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow the sandbox/preview hostnames used during review.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.MUDREXX_API_ORIGIN ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
