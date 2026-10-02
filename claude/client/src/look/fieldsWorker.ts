/**
 * T23.06: the round-start terrain fields, off the main thread. A copy of the map (its RLE and the
 * fields that name its generator run — `map_init`'s, or a local map's own) goes in; the generator's
 * landform is re-derived (T23.05B, with the map build's ground fill — T23.06B F4) and the full field
 * pass run on a `GameCore` of this worker's own; the "was rock" mask (bit words — F6) and the field
 * buffers come back, transferred. ~1.6 s on a Large map (wasm, release, SwiftShader box) that never
 * lands on a frame. `terrainFields.ts` installs the result.
 *
 * **`strays` (F9):** mask px the re-derived landform lacks — version skew between this client's
 * generator and the server's. The pass has then already fallen back to "was rock" = the mask
 * (`render_fields.rs::full_landform`); the caller reports it.
 */
import init, { GameCore } from '../core/pkg/game_wasm.js'
import wasmUrl from '../core/pkg/game_wasm_bg.wasm?url'

export interface FieldsJob {
  id: number
  w: number
  h: number
  rle: Uint8Array
  /** `[seed_lo, seed_hi, scale, generator, theme, shape, look]` (shape: T23.30; look: T23.31). */
  key: number[]
}

/** Sent once to a new worker (T23.06B F2): instantiate the wasm now, so the first job does not wait for it. */
export interface FieldsWarm {
  warm: true
  module?: WebAssembly.Module
}

export type FieldsResult =
  | { id: number; ok: true; wall: Uint32Array; rgba: Uint8Array; din2: Uint16Array; strays: number; ms: number }
  | { id: number; ok: false; error: string }

let ready: Promise<unknown> | null = null

self.onmessage = async (e: MessageEvent<FieldsJob | FieldsWarm>): Promise<void> => {
  if ('warm' in e.data) {
    ready ??= init({ module_or_path: e.data.module ?? wasmUrl })
    return
  }
  const job = e.data
  const post = (r: FieldsResult, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(r, transfer)
  try {
    ready ??= init({ module_or_path: wasmUrl })
    await ready
    const t0 = performance.now()
    const core = new GameCore()
    const [lo, hi, scale, generator, theme, shape, look] = job.key as [number, number, number, number, number, number, number]
    core.set_map_generator(generator)
    if (!core.load_mask(job.w, job.h, job.rle)) throw new Error('fields worker: mask failed to load')
    // T23.30: the shape is the key's sixth element (`renderFieldsOwnKey`, `GameScene.onMapInit`); T23.31: the world
    // look its seventh — it picks the relief's boulder threshold.
    const out = core.render_fields_full_landform(lo, hi, scale, generator, theme, shape ?? 0, look ?? 0)
    const wall = core.render_fields_wall_words()
    // Copies out of this worker's wasm memory, so the buffers can be transferred.
    const rgba = core.render_fields_rgba_copy()
    const din2 = core.render_fields_din2_copy()
    core.free()
    post({ id: job.id, ok: true, wall, rgba, din2, strays: out[4] ?? 0, ms: performance.now() - t0 }, [wall.buffer, rgba.buffer, din2.buffer])
  } catch (err) {
    post({ id: job.id, ok: false, error: String(err) })
  }
}
