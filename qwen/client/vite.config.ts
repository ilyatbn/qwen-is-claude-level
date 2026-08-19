import { defineConfig } from 'vitest/config';

export default defineConfig({
  // docs/07 §1 puts the asset tree at the repo root, and docs/07 §2's manifest
  // paths ("processed/tiles/grass_1.png") are relative to it — so that tree,
  // not client/public, is what the dev server and the build must serve.
  // Raw pack downloads under assets/kenney are git-ignored, so publishing the
  // whole tree publishes only processed output.
  publicDir: '../assets',
  // Without this, Vite's SPA fallback answers a missing asset with index.html
  // and a 200 — so a missing texture reaches Phaser as HTML and fails only
  // because an image decoder rejects it. The game has one HTML entry point and
  // no client-side routing, so disabling the fallback costs nothing and makes
  // a missing asset a plain 404.
  appType: 'mpa',
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
