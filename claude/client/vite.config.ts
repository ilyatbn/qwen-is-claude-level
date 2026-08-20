import { defineConfig } from 'vite'

export default defineConfig({
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
})
