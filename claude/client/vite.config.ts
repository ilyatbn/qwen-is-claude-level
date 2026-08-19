import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // `ws: true` is not optional: without it socket.io silently degrades to
      // long-polling, which looks like unexplained lag rather than a config error.
      // See docs/62-docker-deploy.md §6.
      '/socket.io': { target: 'http://localhost:3000', ws: true },
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
