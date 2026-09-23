import { buildMask, derive, W, H } from './world.js'
import { ARENA, SPACE } from './maps.js'

const v = new URLSearchParams(location.search).get('v')
const t0 = performance.now()

async function run() {
  if (v === 'debugmask' || v === 'debugspace') {
    const m = derive(buildMask(v === 'debugmask' ? ARENA : SPACE), v === 'debugmask' ? 'meadow' : 'asteroid')
    const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c)
    const ctx = c.getContext('2d'); ctx.fillStyle = '#6b9bd8'; ctx.fillRect(0, 0, W, H)
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H
    const a = new Uint8ClampedArray(m.albedo); for (let i = 3; i < a.length; i += 4) if (a[i]) a[i] = 255
    tmp.getContext('2d').putImageData(new ImageData(a, W, H), 0, 0); ctx.drawImage(tmp, 0, 0)
    console.log('derive ms', Math.round(performance.now() - t0))
  } else {
    const mod = await import(`./variant_${v}.js`)
    await mod.default()
    console.log('total ms', Math.round(performance.now() - t0))
  }
  window.__done = true
}
run().catch(e => { console.log('ERR', e.stack); window.__done = true })
