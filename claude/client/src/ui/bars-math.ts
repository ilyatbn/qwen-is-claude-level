/**
 * The arithmetic behind §C8's bottom-left cluster: health, energy and jetpack.
 *
 * Split from the DOM half for the reason every `ui/` module is: `vitest` runs
 * with `environment: 'node'`, so this is where the behaviour can be driven
 * directly. The rendering is asserted on sampled pixels in
 * `scripts/checks/hud-bars.mjs` (§C2).
 */

/** A bar's fill fraction and colour. */
export interface BarView {
  /** 0..1 of the bar's own track. */
  fill: number
  /** `#rrggbb`. */
  colour: string
  /** What the numeric overlay reads. */
  label: string
  /**
   * 0..1 of the track that is **overheal** — health above `BASE_HEALTH`, drawn
   * as a second band rather than by letting `fill` exceed 1.
   */
  over: number
}

/** Linear blend between two `#rrggbb` strings. */
export function mix(a: string, b: string, t: number): string {
  const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16)
  const u = Math.min(1, Math.max(0, t))
  const c = (i: number) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * u)
  return `#${[0, 1, 2].map((i) => c(i).toString(16).padStart(2, '0')).join('')}`
}

const RED = '#e0342b'
const GREEN = '#3ec75a'
/** Overheal band: distinct from full health, or the cap is invisible. */
const GOLD = '#ffc93f'

/**
 * Health, red at 0 through green at `BASE_HEALTH`, with anything above that
 * shown as a gold band.
 *
 * The **track is `HEALTH_CAP` wide**, not `BASE_HEALTH`. §C8 asks for the
 * overheal to be shown, and a bar that saturates at 100 cannot show 150 — it
 * would read as "full" at both, which is the one thing the player needs to tell
 * apart. So a full-but-not-overhealed bar is two thirds of the track, and that is
 * deliberate.
 */
export function healthBar(health: number, base: number, cap: number): BarView {
  const h = Math.min(cap, Math.max(0, health))
  const t = base <= 0 ? 1 : Math.min(1, h / base)
  return {
    fill: cap <= 0 ? 0 : Math.min(h, base) / cap,
    over: cap <= 0 ? 0 : Math.max(0, h - base) / cap,
    colour: h > base ? GOLD : mix(RED, GREEN, t),
    label: String(Math.round(h)),
  }
}

/** Energy, blue, flat colour: it is a quantity, not a warning. */
export function energyBar(battery: number, max: number): BarView {
  const b = Math.min(max, Math.max(0, battery))
  return {
    fill: max <= 0 ? 0 : b / max,
    over: 0,
    colour: '#3aa0ff',
    label: String(Math.round(b)),
  }
}

/**
 * Jetpack fuel, yellow, with the **refill delay made visible**.
 *
 * `JETPACK_REFILL_DELAY` is half a second in which a tank that is not full does
 * not rise. A bar alone cannot show the difference between waiting and climbing
 * at half the drain rate — which is what §C26's number was added for — so the
 * delay gets its own state here: the bar dims and the label says so. Without it
 * the readout looks broken for half a second after every burst.
 */
export function jetpackBar(fuel: number, max: number, refilling: boolean): BarView {
  const f = Math.min(max, Math.max(0, fuel))
  return {
    fill: max <= 0 ? 0 : f / max,
    over: 0,
    colour: refilling ? '#8a7420' : '#ffd23f',
    label: f.toFixed(1),
  }
}

/**
 * True while the tank is in `JETPACK_REFILL_DELAY` — not full, not draining, and
 * not yet rising.
 *
 * Derived from two samples rather than from a flag, because the client is not
 * told when the delay starts: `jetpack.fuel` is in the snapshot and the timer is
 * not. Derive, do not add a fourth flag.
 */
export function inRefillDelay(prev: number, now: number, max: number, jetting: boolean): boolean {
  if (jetting || now >= max) return false
  return now <= prev + 1e-4
}

/**
 * How much of the shield's ring is left, 0..1, or null when there is no shield.
 *
 * The shield is a **timer**, not a pool (`docs/21` §2), so it is drawn as a ring
 * around the cluster and not as part of the health bar. §B5 makes the battery
 * end it early — the battery drains at `SHIELD_DRAIN` while it is up — so the
 * remaining time is whichever of the two runs out first, and that is the whole
 * point of showing them together.
 */
export function shieldRing(
  active: boolean,
  startedAt: number,
  now: number,
  duration: number,
  battery: number,
  drain: number,
): number | null {
  if (!active || duration <= 0) return null
  const byTime = duration - (now - startedAt)
  const byBattery = drain > 0 ? battery / drain : Infinity
  return Math.max(0, Math.min(1, Math.min(byTime, byBattery) / duration))
}
