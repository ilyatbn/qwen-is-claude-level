import Phaser from 'phaser'
import { BootScene } from './scenes/BootScene'
import { PreviewScene } from './scenes/PreviewScene'
import { SandboxScene } from './scenes/SandboxScene'
import { C, Core } from './core'

// No constants are declared here. VIEWPORT_W/H used to be literals in this file —
// a second source of truth for numbers that live in game-core/src/constants.rs.
// They now cross the WASM boundary with everything else. See docs/01-architecture.md.
/** `?sandbox=1` is the dev tool, `?preview=1` the bare render harness. */
function pickScene(): Phaser.Types.Scenes.SceneType[] {
  const q = new URLSearchParams(location.search)
  if (q.get('sandbox') === '1') return [SandboxScene]
  if (q.get('preview') === '1') return [PreviewScene]
  return [BootScene]
}

async function main(): Promise<Phaser.Game> {
  const core = await Core.init()
  const c = C()

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: c.VIEWPORT_W,
    height: c.VIEWPORT_H,
    backgroundColor: '#0b1020',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      pixelArt: true,
      antialias: false,
    },
    scene: pickScene(),
  })

  // Right-click is the inventory toggle (docs/30-items-inventory.md §3), so the
  // browser context menu has to go.
  const suppress = (e: Event) => e.preventDefault()
  game.canvas?.addEventListener('contextmenu', suppress)
  document.getElementById('game')?.addEventListener('contextmenu', suppress)

  // The scenes need the core; Phaser's registry is the least surprising channel.
  game.registry.set('core', core)
  return game
}

export default main()
