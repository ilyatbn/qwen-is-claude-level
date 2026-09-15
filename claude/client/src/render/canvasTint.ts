/**
 * T21.37: sprite tints baked into textures, for Phaser's **Canvas** renderer.
 *
 * Canvas's `batchSprite` has no tint, so `setTint` draws the art untinted — the red Recruit
 * (skin 5, `0xff8a7a` over skin 0's frames) came out as the plain Recruit. WebGL multiplies each
 * texel by the tint in the shader; this does the same multiply once, on a copy of the atlas.
 *
 * **Not `parallax.ts::recolourRidge`**, deliberately: that is `source-in`, which floods every
 * opaque texel with one flat colour. It is right for a white-baked silhouette and wrong for
 * character art, which would become a single-colour blob.
 */

import Phaser from 'phaser'

/**
 * Multiply RGBA texels by a `0xRRGGBB` tint in place, keeping alpha — WebGL's multiply tint.
 * Pure, so the arithmetic is tested without a canvas.
 */
export function multiplyTint(data: Uint8ClampedArray, tint: number): void {
  const r = (tint >> 16) & 255
  const g = (tint >> 8) & 255
  const b = tint & 255
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round((data[i]! * r) / 255)
    data[i + 1] = Math.round((data[i + 1]! * g) / 255)
    data[i + 2] = Math.round((data[i + 2]! * b) / 255)
  }
}

/** The part of `Phaser.Textures.Frame#data` a trimmed frame needs copied. */
interface FrameData {
  trim: boolean
  sourceSize: { w: number; h: number }
  spriteSourceSize: { x: number; y: number; w: number; h: number }
}

/** The key a baked copy of `atlas` in `tint` lives under. One per (atlas, tint). */
export function tintedKey(atlas: string, tint: number): string {
  return `${atlas}__tint_${tint.toString(16).padStart(6, '0')}`
}

/**
 * A copy of atlas `atlas` with every texel multiplied by `tint`, every frame re-added under the
 * **same name and rectangle** — so `framesFor` needs no change, only the texture key does.
 *
 * Baked once per (atlas, tint) and kept: the texture manager is global, and every `PlayerView`
 * rebuild of a remote asks again. Returns the source key if the copy cannot be made (no 2d
 * context), which draws the untinted art — the pre-T21.37 picture, not a crash.
 */
export function bakeTintedAtlas(textures: Phaser.Textures.TextureManager, atlas: string, tint: number): string {
  const key = tintedKey(atlas, tint)
  if (textures.exists(key)) return key
  const src = textures.get(atlas)
  const img = src.getSourceImage() as CanvasImageSource & { width: number; height: number }
  const tex = textures.createCanvas(key, img.width, img.height)
  const ctx = tex?.getContext()
  if (!tex || !ctx) return atlas
  ctx.drawImage(img, 0, 0)
  const pixels = ctx.getImageData(0, 0, img.width, img.height)
  multiplyTint(pixels.data, tint)
  ctx.putImageData(pixels, 0, 0)
  for (const name of src.getFrameNames()) {
    const f = src.get(name)
    const copy = tex.add(name, 0, f.cutX, f.cutY, f.cutWidth, f.cutHeight)
    // `chars.json` is untrimmed today; a trimmed pack must keep its offsets or bodies jitter.
    // Phaser's typings omit `Frame#data`, which the atlas parser fills and `setTrim` writes.
    const data = (f as unknown as { data: FrameData }).data
    if (copy && data.trim) {
      const ss = data.spriteSourceSize
      copy.setTrim(data.sourceSize.w, data.sourceSize.h, ss.x, ss.y, ss.w, ss.h)
    }
  }
  tex.refresh()
  return key
}
