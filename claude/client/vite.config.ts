import { defineConfig } from 'vite'

/**
 * §C17: the dev surface is **compiled out**, not gated at runtime.
 *
 * `import.meta.env.DEV` alone cannot express what is wanted, because it is false
 * in *every* build including the one the browser checks drive. So the flag is its
 * own define, true in `dev` and in `--mode e2e` and false in a plain
 * `vite build` — and because it is a literal by then, every `if (__DEV_SURFACE__)`
 * body is dead code that the bundler deletes rather than ships.
 *
 * A server-side toggle was the alternative and §C17 rejects it: it still ships
 * the code, so a modified client flips it back, and it needs a message, server
 * state and a round trip that removal does not.
 */
export default defineConfig(({ mode }) => ({
  define: {
    __DEV_SURFACE__: JSON.stringify(mode === 'development' || mode === 'e2e'),
  },
  // Art lives at the project root, not under client/, because `assets/` is shared
  // with the build scripts and the docs describe it there (`docs/51` §1). Vite
  // serves it as the public dir, so manifest paths like `atlas/chars.png` resolve
  // as `/atlas/chars.png` in dev and are copied verbatim into dist on build.
  publicDir: '../assets',
  server: {
    port: 5173,
    proxy: {
      // `ws: true` is not optional: without it socket.io silently degrades to
      // long-polling, which looks like unexplained lag rather than a config error.
      // See docs/62-docker-deploy.md §6.
      // `VITE_SERVER_PORT` so an end-to-end run can point the proxy at its own
      // server instead of whatever is on :3000 — a stale dev server there would
      // otherwise silently serve the test.
      '/socket.io': {
        target: `http://localhost:${process.env['VITE_SERVER_PORT'] ?? 3000}`,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
