/**
 * T23.03B (F10): the world renderer is loaded **on demand**. `worldRenderer.ts` pulls in
 * three.js (~480 kB minified), and a static import from `GameScene` put that in the entry
 * chunk every player downloads before the title screen draws. The scenes that draw the world
 * (`GameScene`, `SandboxScene`, `LookScene`) call this instead, and only a type crosses the
 * static import graph, so three.js is its own chunk fetched when the first of them starts.
 *
 * Three-free on purpose: importing this module must not import `three`.
 */
import type Phaser from 'phaser'

export type WorldModule = typeof import('./worldRenderer')

/**
 * Load `worldRenderer.ts` for `scene`. Resolves with the module, or `null` when the scene
 * shut down before it arrived (a restarted `GameScene` must not get last round's renderer —
 * the new `create()` asked for its own) or the chunk failed to load (warned, the world stays
 * undrawn by three.js — the state `createWorldRenderer`'s own fallback already covers).
 */
export function loadWorldRenderer(scene: Phaser.Scene): Promise<WorldModule | null> {
  let gone = false
  const onShutdown = (): void => {
    gone = true
  }
  scene.events.once('shutdown', onShutdown)
  const settle = (m: WorldModule | null): WorldModule | null => {
    scene.events.off('shutdown', onShutdown)
    return gone ? null : m
  }
  return import('./worldRenderer').then(settle, (e: unknown) => {
    console.warn('the world renderer chunk failed to load; the world is not drawn by three.js:', e)
    return settle(null)
  })
}
