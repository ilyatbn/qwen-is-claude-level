/**
 * T23.06: the round-start terrain fields, off the main thread. A copy of the map (its RLE and the
 * fields that name its generator run — `map_init`'s, or a local map's own) goes in; the generator's
 * landform is re-derived (T23.05B) and the full field pass run on a `GameCore` of this worker's
 * own; the "was rock" mask and the field buffer come back, transferred. ~1.1 s on a Large map
 * (wasm, release) that never lands on a frame. `terrainFields.ts` installs the result.
 */
import init, { GameCore } from '../core/pkg/game_wasm.js'
import wasmUrl from '../core/pkg/game_wasm_bg.wasm?url'

export interface FieldsJob {
  id: number
  w: number
  h: number
  rle: Uint8Array
  /** `[seed_lo, seed_hi, scale, generator, theme]`. */
  key: number[]
}

export type FieldsResult =
  | { id: number; ok: true; wall: Uint8Array; rgba: Uint8Array; din2: Uint16Array; ms: number }
  | { id: number; ok: false; error: string }

let ready: Promise<unknown> | null = null

self.onmessage = async (e: MessageEvent<FieldsJob>): Promise<void> => {
  const job = e.data
  const post = (r: FieldsResult, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(r, transfer)
  try {
    ready ??= init({ module_or_path: wasmUrl })
    await ready
    const t0 = performance.now()
    const core = new GameCore()
    const [lo, hi, scale, generator, theme] = job.key as [number, number, number, number, number]
    core.set_map_generator(generator)
    if (!core.load_mask(job.w, job.h, job.rle)) throw new Error('fields worker: mask failed to load')
    core.render_fields_full_landform(lo, hi, scale, generator, theme)
    const wall = core.render_fields_wall()
    // A copy out of this worker's wasm memory, so the buffer can be transferred.
    const rgba = core.render_fields_rgba_copy()
    const din2 = core.render_fields_din2_copy()
    core.free()
    post({ id: job.id, ok: true, wall, rgba, din2, ms: performance.now() - t0 }, [wall.buffer, rgba.buffer, din2.buffer])
  } catch (err) {
    post({ id: job.id, ok: false, error: String(err) })
  }
}
