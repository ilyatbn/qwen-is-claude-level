import Phaser from 'phaser'
import { BootScene } from './scenes/BootScene'

// The design resolution. These two are pure presentation, which is why they are
// allowed to live here rather than coming from game-core through WASM — every
// other constant does. See docs/02-constants.md → Rendering.
const VIEWPORT_W = 1280
const VIEWPORT_H = 720

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: VIEWPORT_W,
  height: VIEWPORT_H,
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
// browser context menu has to go. One line now, rather than a surprise in M4.
game.canvas?.addEventListener('contextmenu', (e) => e.preventDefault())
document.getElementById('game')?.addEventListener('contextmenu', (e) => e.preventDefault())

export default game
