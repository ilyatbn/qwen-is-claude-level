// T23.20: `render.mjs R3` — F3's region map, `controls/regions-F3.png` (red: 1 sky, 2 terrain, 3 cave = the
// carved backdrop wall), from `world.js::buildMask(SPACE)` exactly as `regions-F1.png` is from ARENA_E.
import { buildMask, W, H } from './world.js'
import { SPACE } from './maps.js'

export default function () {
  document.body.style.cssText = 'margin:0;width:1280px;height:720px;overflow:hidden;background:#000'
  const m = buildMask(SPACE)
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c)
  const img = new ImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = m.solid[i] ? 2 : m.back[i] ? 3 : 1
    img.data[i * 4 + 3] = 255
  }
  c.getContext('2d').putImageData(img, 0, 0)
}
