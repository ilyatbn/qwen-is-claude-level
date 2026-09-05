/**
 * The arithmetic behind the ground animals (T20.10), Phaser-free (§A8).
 *
 * **Sizes come from `C()`, never from a literal here.** The hit box a weapon
 * tests against is `SPIDER_W`/`SPIDER_H` and `BEETLE_W`/`BEETLE_H` in
 * `constants.rs`; a drawn size spelled in this file would drift from it silently,
 * and the symptom — a spider you can see and cannot hit, or the reverse — is the
 * one `birds-math.ts` exists to prevent one entity over.
 */
import { C } from '../core'

/** Wire values, matching `AnimalKind::to_u8`. */
export const SPIDER = 0
export const BEETLE = 1

/** The drawn size, which **is** the hit box. */
export function bodySize(kind: number): { w: number; h: number } {
  const c = C()
  return kind === BEETLE
    ? { w: c.BEETLE_W, h: c.BEETLE_H }
    : { w: c.SPIDER_W, h: c.SPIDER_H }
}

/**
 * Body colour. The two kinds differ in **silhouette** first — a beetle is wider
 * and rounder, a spider is legs — and in colour second, for the reason
 * `tombstoneTextures.ts` states: at this size the outline is what reads.
 */
export function bodyColor(kind: number): number {
  return kind === BEETLE ? 0x6b4f2a : 0x2b2f36
}

/**
 * How far a leg swings, `-1..1`, from a wall clock and the animal's id.
 *
 * **Per-id phase, so a row of spiders is not a chorus line.** Same trick as
 * `wingPhase`, and the same reason: one shared clock makes every animal on
 * screen move in lockstep, which reads as a rendering bug rather than as life.
 */
export function legPhase(nowMs: number, id: number, kind: number): number {
  const period = kind === BEETLE ? 420 : 260
  const t = (nowMs + id * 137) / period
  return Math.sin(t * Math.PI * 2)
}
