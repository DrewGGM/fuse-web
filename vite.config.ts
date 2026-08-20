import { defineConfig } from 'vite';

/**
 * Where the leaderboard lives.
 *
 * Defaults to a sibling subdomain of the site so both halves sit on the same
 * zone and there is one place to reason about DNS. Override for local work:
 *   FUSE_API_BASE=http://localhost:8787 npm run build
 */
const API_BASE = process.env.FUSE_API_BASE ?? 'https://api-fuse.andrewgarcia.dev';

/**
 * Keeps the CSP's connect-src in step with the API this build targets.
 *
 * Hardcoding one host means a build pointed anywhere else has its own API
 * refused by the policy — an error that looks like a network fault and is
 * really a configuration one.
 */
function cspOrigin() {
  return {
    name: 'fuse-csp-origin',
    transformIndexHtml(html: string) {
      return html.replaceAll('%API_ORIGIN%', new URL(API_BASE).origin);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [cspOrigin()],
  define: {
    __API_BASE__: JSON.stringify(API_BASE),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // The point of hand-writing the renderer was a small bundle. Fail loudly if
    // that ever silently regresses.
    chunkSizeWarningLimit: 260,
  },
  server: { port: 5173, host: true },
});
