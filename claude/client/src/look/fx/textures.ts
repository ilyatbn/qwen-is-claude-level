/**
 * T23.18: `kit.js::softTex` and `kit.js::smokeTex`, drawn the mockup's way (a 128 px canvas, `canvasTex`: an sRGB
 * `CanvasTexture`) so a sprite samples the same texels the reference's did. `smokeTex` spends the first
 * `SMOKE_TEX_DRAWS` of `rnd` from seed 7 — exactly the draws the mockup's first explosion's texture spent.
 */
import { CanvasTexture, SRGBColorSpace } from 'three'
import { Lcg, SMOKE_TEX_DRAWS } from './kit'

const SIZE = 128

function canvasTex(draw: (g: CanvasRenderingContext2D, s: number) => void): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  const g = c.getContext('2d')
  if (!g) throw new Error('fx textures: no 2D context')
  draw(g, SIZE)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
}

export function softTex(): CanvasTexture {
  return canvasTex((g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    gr.addColorStop(0, 'rgba(255,255,255,1)')
    gr.addColorStop(0.35, 'rgba(255,255,255,0.45)')
    gr.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = gr
    g.fillRect(0, 0, s, s)
  })
}

export function smokeTex(): CanvasTexture {
  const rnd = new Lcg(7)
  return canvasTex((g, s) => {
    for (let i = 0; i < SMOKE_TEX_DRAWS / 3; i++) {
      const x = s / 2 + (rnd.next() - 0.5) * s * 0.45
      const y = s / 2 + (rnd.next() - 0.5) * s * 0.45
      const r = s * (0.12 + rnd.next() * 0.2)
      const gr = g.createRadialGradient(x, y, 0, x, y, r)
      gr.addColorStop(0, 'rgba(255,255,255,0.55)')
      gr.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = gr
      g.beginPath()
      g.arc(x, y, r, 0, 7)
      g.fill()
    }
  })
}
