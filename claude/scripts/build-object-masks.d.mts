import type { Box, MaskRecord, Rational } from './lib/object-masks.d.mts'
import type { RustConstants } from './lib/rust-constants.d.mts'

export interface ObjectSource {
  key: string
  pack: string
  category: string
  rel: string
  file: string
}

export interface MeasuredSource extends ObjectSource {
  bounds: Box
}

export interface ObjectEntry extends ObjectSource {
  id: number
  empty: boolean
  bounds: Box
  w: number
  h: number
  anchorX: number
  anchorY: number
  packed: Uint8Array
  art: Uint8Array
}

export interface ObjectManifestRow {
  id: number
  key: string
  pack: string
  category: string
  source: string
  w: number
  h: number
  anchor: { x: number; y: number }
  offset: number
  bytes: number
}

export interface ObjectManifest {
  meta: {
    app: string
    version: number
    masks: string
    factors: Record<string, Rational>
  }
  objects: ObjectManifestRow[]
}

export interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number }
  rotated: boolean
  trimmed: boolean
  spriteSourceSize: { x: number; y: number; w: number; h: number }
  sourceSize: { w: number; h: number }
}

export interface ObjectAtlas {
  frames: Record<string, AtlasFrame>
  meta: { image: string; size: { w: number; h: number } }
}

export interface BuildResult {
  sources: ObjectSource[]
  measured: MeasuredSource[]
  factors: Map<string, Rational>
  entries: ObjectEntry[]
  empty: string[]
  masks: Uint8Array
  manifest: ObjectManifest
  atlas: ObjectAtlas
  atlasPng: Uint8Array
}

export declare const PACK_ROOT: string
export declare const PACKS: ReadonlyArray<{
  pack: string
  category: string
  include(rel: string): boolean
}>

export declare const TARGET_CONSTANT: Record<string, string>

export declare function selectSources(packRoot?: string): ObjectSource[]
export declare function targetHeightPx(category: string, table?: RustConstants): number
export declare function measureBounds(
  rgba: Uint8Array,
  w: number,
  h: number,
  threshold: number,
): Box
export declare function packFactors(
  measured: readonly MeasuredSource[],
  table?: RustConstants,
): Map<string, Rational>
export declare function buildEntry(
  source: ObjectSource,
  rgba: Uint8Array,
  w: number,
  h: number,
  threshold: number,
  factor: Rational,
): ObjectEntry
export declare function build(packRoot?: string): BuildResult
export type { Box, MaskRecord, Rational }
