/**
 * T23.19: the world's furniture as world-renderer actors — pickups (their labels are Phaser's since T23.19D), graves, the ground animals and
 * the crystals — drawn by `draw.ts` into the actor atlas, **behind** every figure (`cast.ts`, `back`). Until now the
 * first four were Phaser's, on the canvas over the world's, so a figure standing on one was covered by it and T23.19A
 * drew such a figure through Phaser instead (`PlayerView.overPhaser`, retired with this file).
 *
 * Sizes come from the simulation's boxes (the animals' hit boxes, the grave's `TOMBSTONE_*`), passed in by the layers,
 * so the picture cannot drift from what a weapon tests against. No Phaser at run time (`joinCrystals` takes its scene type).
 */
import type Phaser from 'phaser'
import type { Actor, Light, LitOpts, RgbString } from '../scene'
import { joinCast } from './cast'
import { CRYSTAL_LIGHT, place } from '../effectLights'
import { ICON_ACCENT, ICON_CENTRE_UNITS, ICON_RES, ICON_UNIT_PX, iconWeapon } from './icons'
import { HALO_A } from './cell'

/** A pickup's lighting: rim-lit by whatever is near (a muzzle, a gate, the moon), no shadow — it lies on the rock. */
const PICKUP_LIT: LitOpts = { size: 1, halo: null, shadow: false }
/** A non-weapon pickup's scale: `draw.ts::item` is ~16 units across, the painted icons' 16 px. */
export const ITEM_S = 1

/**
 * F4's night halo round its small creatures (`variant_F4.js`: beetle and spider `halo: '120,120,170'`) — a faint cool
 * glow behind the ink, so a dark shape reads against dark rock. The graves wear it too (T23.15's owed item: an ink
 * stone disappeared into the night rock).
 */
export const NIGHT_HALO: RgbString = '120,120,170'

/**
 * T23.19D F2: **the night halo is a night thing.** It fades with the scene's night (`t` = darkness / `NIGHT_DARKNESS`,
 * R7's blend factor: 0 noon, 1 full night) — at noon there is none; the review found it drawn at noon. In
 * `NIGHT_HALO_STEPS` steps, because a halo is baked into its actor's atlas cell: a continuous fade would redraw every
 * grave and animal every frame through dusk.
 */
export const NIGHT_HALO_STEPS = 4
export function nightHalo(night: number): Pick<LitOpts, 'halo' | 'haloAlpha'> {
  const q = Math.round(Math.min(1, Math.max(0, night)) * NIGHT_HALO_STEPS) / NIGHT_HALO_STEPS
  return q > 0 ? { halo: NIGHT_HALO, haloAlpha: HALO_A * q } : { halo: null }
}

/**
 * A pickup of registry sprite `sprite` centred on (x, y): a weapon is its held model at the icon's fitted scale
 * (`itemTextures.ts` measured it: `ICON_UNIT_PX`, `ICON_CENTRE_UNITS`), anything else `draw.ts::item`.
 */
export function pickupActor(sprite: string, x: number, y: number): Actor {
  const key = iconWeapon(sprite)
  const unit = ICON_UNIT_PX.get(sprite)
  if (key && unit) {
    const s = unit / ICON_RES
    const [cx, cy] = ICON_CENTRE_UNITS.get(sprite) ?? [0, 0]
    return { kind: 'weapon', x, y, opts: { key, s, origin: [-cx * s, -cy * s], accent: ICON_ACCENT }, lit: PICKUP_LIT, box: null }
  }
  return { kind: 'item', x, y, opts: { key: sprite, s: ITEM_S, accent: ICON_ACCENT }, lit: PICKUP_LIT, box: null }
}

/** `draw.ts::grave`'s height at `s` 1 (mound to the stone's top). */
export const GRAVE_ART_H = 16
/** A grave standing on the feet line at (x, y), `h` world px tall (`TOMBSTONE_H`), at the scene's `night` (0–1). */
export function graveActor(x: number, y: number, h: number, night: number): Actor {
  return { kind: 'grave', x, y, opts: { s: h / GRAVE_ART_H }, lit: { size: 1, ...nightHalo(night), shadow: true }, box: null }
}

/** Wire kinds (`animals-math.ts`): 0 spider, 1 beetle. */
export const BEETLE_KIND = 1
/** The drawn body's width at `s` 1 (`draw.ts::beetle`'s shell and head; `spider`'s two discs) — scaled to the hit box. */
export const BEETLE_ART_W = 16
export const SPIDER_ART_W = 12.5

/**
 * `lit()`'s size per unit of an animal's scale: F4 lights its 3× beetle and spider at `size` 2. At the game's scale the
 * halo is then F4's in proportion (radius 30 × size); lit at size 1 a 12-px spider wore a 30-px halo (the first shots).
 */
export const ANIMAL_LIT_PER_S = 2 / 3

/**
 * T23.31: the volcanic world's animals on the same wire kinds (§A7: a look picks *which* animals, the simulation keeps
 * its two): the beetle's place is the **tripod walker**'s, the spider's the **octopus crawler**'s. Art widths are their
 * bodies' (`draw.ts::tripod`'s dome, `crawler`'s mantle and near legs), scaled to the hit box as the classic two are —
 * the tripod's stilts stand above its box, as the spider's legs reach past its.
 */
export const TRIPOD_ART_W = 12
export const CRAWLER_ART_W = 11
/** Walk-cycle steps a creature is drawn in: one atlas cell each, reused every stride (`BIRD_FLAP_STEPS`'s reason). */
export const GAIT_STEPS = 6

/**
 * A ground animal whose hit box (`w` × `h`) is centred on (x, y), facing right or left, at the scene's `night` (0–1).
 * `fauna` (T23.31): the world's animals — classic F4's beetle and spider, volcanic the tripod and the crawler, walking
 * at `gait` (0–1, quantised to `GAIT_STEPS`).
 */
export function animalActor(kind: number, x: number, y: number, right: boolean, w: number, h: number, night: number, fauna: 'classic' | 'volcanic' = 'classic', gait = 0): Actor {
  if (fauna === 'volcanic') {
    const tri = kind === BEETLE_KIND
    const s = w / (tri ? TRIPOD_ART_W : CRAWLER_ART_W)
    const step = Math.round((((gait % 1) + 1) % 1) * GAIT_STEPS) % GAIT_STEPS
    return {
      kind: tri ? 'tripod' : 'crawler',
      x,
      y: y + h / 2,
      opts: { s, face: right ? 1 : -1, gait: step / GAIT_STEPS },
      lit: { size: ANIMAL_LIT_PER_S * s, ...nightHalo(night), shadow: false },
      box: null,
    }
  }
  const beetle = kind === BEETLE_KIND
  const s = w / (beetle ? BEETLE_ART_W : SPIDER_ART_W)
  return {
    kind: beetle ? 'beetle' : 'spider',
    x,
    y: y + h / 2,
    opts: { s, face: right ? 1 : -1 },
    lit: { size: ANIMAL_LIT_PER_S * s, ...nightHalo(night), shadow: false },
    box: null,
  }
}

/** `draw.ts::bird`'s span at `s` 1 (wing tip to wing tip), which the hit box's width scales to. */
export const BIRD_ART_W = 20
/**
 * F4 lights its 3× birds at `size` 1.5 (`variant_F4.js`): per unit of scale, as the animals'. No halo: a bird is
 * against the sky, not the rock.
 */
export const BIRD_LIT_PER_S = 1.5 / 3
/**
 * Wing positions a bird is drawn in (`flap` 0 down … 1 up): its phase is continuous (`birds-math.ts::wingPhase`), its
 * drawing is not — each step is one atlas cell, reused every beat, where a continuous flap redrew every bird every frame.
 */
export const BIRD_FLAP_STEPS = 6

/** A bird whose hit box (`w` wide) is centred on (x, y), flying right or left, wings at `phase` (−1 down … 1 up). */
export function birdActor(metal: boolean, x: number, y: number, right: boolean, w: number, phase: number): Actor {
  const s = w / BIRD_ART_W
  const flap = Math.round(((phase + 1) / 2) * (BIRD_FLAP_STEPS - 1)) / (BIRD_FLAP_STEPS - 1)
  return { kind: 'bird', x, y, opts: { s, face: right ? 1 : -1, flap, ...(metal ? { metal: true } : {}) }, lit: { size: BIRD_LIT_PER_S * s, halo: null, shadow: false }, box: null }
}

/**
 * The objects manifest's crystal entries (`assets/objects/manifest.json`, category `crystal`): ids `from` … `to - 1`.
 * `furniture.test.ts` reads the manifest and holds this to it.
 */
export const CRYSTAL_OBJECT_IDS = { from: 40, to: 80 } as const
export function isCrystal(id: number): boolean {
  return id >= CRYSTAL_OBJECT_IDS.from && id < CRYSTAL_OBJECT_IDS.to
}

/** `draw.ts::crystals` at `s` 1: its tallest shard (10 + 16 × 1.4). */
export const CRYSTAL_ART_H = 32
/**
 * The largest cluster: F1's own (`s` 1, ~30 px). Scaled to a stamp's height (~58 px) the glow grew to a ~40 px ball
 * that bloom blew up past the whole ledge (shots/furniture-crystals.png, first run) — F1's clusters are small lights.
 */
export const CRYSTAL_S_MAX = 1
/** F1's crystal glow (`P.crystal`, `f_scene.js`: the clusters' `glowRGB`). */
export const CRYSTAL_GLOW: RgbString = '110,170,255'

/** A stamped object's rect (`map_init`'s objects: top-left, size). */
export interface StampedObject {
  id: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * R5: a stamped crystal is rock in the mask and terrain in the picture — **plus one of F's clusters** standing on its
 * base — F1's size, or the stamp's height if smaller — with its glow (F1 draws single clusters; several per stamp, measured, overlapped their
 * glows into one flat blue slab across the rock). The id seeds it, so a map draws the same crystals every time.
 */
export function crystalActors(o: StampedObject): Actor[] {
  const s = Math.min(CRYSTAL_S_MAX, o.h / CRYSTAL_ART_H)
  return [
    {
      kind: 'crystals',
      x: o.x + o.w / 2,
      y: o.y + o.h,
      opts: { s, glowRGB: CRYSTAL_GLOW, seed: o.id * 7 + 1, n: 5 },
      lit: { size: 1, halo: null, shadow: false },
      box: null,
    },
  ]
}

/** The crystals' lights (`effectLights.ts::CRYSTAL_LIGHT`), one per stamp, 14 px up its middle as F1 places it. */
export function crystalLights(objects: readonly StampedObject[]): Light[] {
  return objects.filter((o) => isCrystal(o.id)).flatMap((o) => place(CRYSTAL_LIGHT, o.x + o.w / 2, o.y + o.h - 14) ?? [])
}

/** Is (x, y) within the view grown by `margin` (world px)? The furniture is map-wide; only what is near is drawn. */
export function nearView(view: { x: number; y: number; width: number; height: number }, x: number, y: number, margin: number): boolean {
  return x >= view.x - margin && x <= view.x + view.width + margin && y >= view.y - margin && y <= view.y + view.height + margin
}
/** The margin: the largest furniture drawing's reach (a label plate, a grave's halo). */
export const VIEW_MARGIN = 64

/**
 * The map's crystals into the scene's cast, behind the figures, each drawn while near the view and `on()` (not in
 * space, where the world renderer draws no actors). Returns the call that takes them out again (a new map).
 */
export function joinCrystals(scene: Phaser.Scene, objects: readonly StampedObject[], on: () => boolean): () => void {
  const view = scene.cameras.main.worldView
  const leaves = objects
    .filter((o) => isCrystal(o.id))
    .flatMap((o) => crystalActors(o))
    .map((a) => joinCast(scene, { back: true, actor: () => (on() && nearView(view, a.x, a.y, VIEW_MARGIN) ? a : null) }))
  return () => {
    for (const l of leaves) l()
  }
}
