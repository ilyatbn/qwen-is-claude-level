import Phaser from 'phaser'
import { BootScene } from './scenes/BootScene'
import { C, Core } from './core'

// No constants are declared here. VIEWPORT_W/H used to be literals in this file —
// a second source of truth for numbers that live in game-core/src/constants.rs.
// They now cross the WASM boundary with everything else. See docs/01-architecture.md.
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
    scene: [BootScene],
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
