/**
 * T23.06's dev hooks on the terrain, moved out of `WorldRenderer` (T23.06B F11): the flat albedo view
 * (the look-lab's `only=albedo`), the state `window.__world.terrain()` reports, and the controls the
 * checks use — a from-scratch repaint, albedo readback, the GLSL hash probe. Nothing in a match calls
 * these; `worldHandle.ts` (dev surface only) and `WorldRenderer.showAlbedo` do.
 */
import { GLSL3, Mesh, PlaneGeometry, Scene, ShaderMaterial, type Texture, type WebGLRenderer } from 'three'
import type { TerrainLayer } from './terrainLayer'
import { TerrainGpu, type Rect } from './terrainGpu'
import { toWorld } from './worldRenderer-math'

/** A world-sized quad showing the albedo flat: sRGB bytes straight to the canvas, air black. */
export interface AlbedoView {
  readonly scene: Scene
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>
}

export function makeAlbedoView(w: number, h: number, worldH: number, albedo: Texture | null): AlbedoView {
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { albedo: { value: albedo }, size: { value: [w, h] } },
    vertexShader: /* glsl */ `
      uniform vec2 size; out vec2 px;
      void main() { px = vec2(uv.x, 1.0 - uv.y) * size; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float; uniform sampler2D albedo; in vec2 px; out vec4 fragColor;
      void main() {
        vec4 a = texelFetch(albedo, ivec2(floor(px)), 0);
        fragColor = a.a > 0.0 ? vec4(a.rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  })
  const mesh = new Mesh(new PlaneGeometry(w, h), mat)
  const c = toWorld(w / 2, h / 2, worldH)
  mesh.position.set(c.x, c.y, 0)
  mesh.frustumCulled = false
  const scene = new Scene()
  scene.add(mesh)
  return { scene, mesh }
}

/** Point the view at the layer's current albedo (a new GPU side on a new map). */
export function syncAlbedoView(v: AlbedoView, layer: TerrainLayer): void {
  const tex = layer.gpu?.albedo.texture ?? null
  const u = v.mesh.material.uniforms['albedo']!
  if (u.value !== tex) u.value = tex
}

export function disposeAlbedoView(v: AlbedoView): void {
  v.mesh.geometry.dispose()
  v.mesh.material.dispose()
}

/** The terrain's state — fields in, readiness (F3), work left, counts, costs, the feed's own stats. */
export function terrainInfo(layer: TerrainLayer, albedoView: boolean): {
  fields: boolean
  gpu: boolean
  /** F3: the picture is whole — T23.07's switch. */
  ready: boolean
  pending: number
  lastUpdateMs: number
  maxUpdateMs: number
  maxPumpMs: number
  kept: number
  /** F5: bytes the GPU side holds. */
  bytes: number
  albedoView: boolean
  w: number
  h: number
  lastScorch: [number, number, number] | null
  feed: Readonly<Record<string, number | string>> | null
} & TerrainGpu['stats'] {
  const g = layer.gpu
  return {
    fields: layer.feed?.ready ?? false,
    gpu: !!g,
    ready: layer.ready,
    pending: layer.pending,
    ...layer.stats,
    bytes: g?.bytes ?? 0,
    lastScorch: g?.lastScorch ?? null,
    feed: layer.feed?.stats ?? null,
    albedoView,
    w: layer.feed?.w ?? 0,
    h: layer.feed?.h ?? 0,
    ...(g?.stats ?? { tiles: 0, dirtyPaints: 0, scorches: 0, uploads: 0, uploadedPx: 0, bakes: 0 }),
  }
}

/** The from-scratch control an incremental update is compared with: every field re-uploaded, the whole albedo repainted, now. */
export function repaintAlbedo(layer: TerrainLayer): void {
  const v = layer.feed?.view()
  const d = layer.feed?.din2()
  const g = layer.gpu
  if (!g || !v || !d) return
  g.queueAll() // every field strip, then every tile
  g.step(Infinity, () => {
    const view = layer.feed?.view()
    const din2 = layer.feed?.din2()
    return view && din2 ? { view, din2 } : null
  })
}

/**
 * A blast's scorch **alone** — no carve — through the production path (`TerrainGpu.addScorch`: the
 * mask, then the albedo over its box grown by `ALBEDO_REACH`). T23.06B F8: the case where the reach
 * is not covered by a fields rect — a scorch that burns a surface kills the grass blades up to 19 px
 * above it, outside the scorch's own box.
 */
export function scorchOnly(layer: TerrainLayer, x: number, y: number, r: number): Rect | null {
  return layer.gpu?.addScorch(x, y, r) ?? null
}

export function takeAlbedoPaints(layer: TerrainLayer): Rect[] {
  return layer.gpu?.takePaints() ?? []
}

export function readAlbedo(layer: TerrainLayer, r: Rect): Uint8Array | null {
  return layer.gpu?.readAlbedo(r) ?? null
}

/** The GLSL hash's 10k words (`albedo.ts::HASH_PROBE_FS`), on the layer's GPU side or a throwaway one. */
export function hashProbe(renderer: WebGLRenderer, layer: TerrainLayer): Uint32Array {
  const g = layer.gpu ?? new TerrainGpu(renderer, 1, 1)
  const out = g.hashProbe()
  if (g !== layer.gpu) g.dispose()
  return out
}
