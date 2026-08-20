/**
 * The pure half of the camera: follow, deadzone, lookahead, bounds and trauma.
 *
 * DOM-free and Phaser-free (`docs/70-amendments-v2.md` §A8) so every rule here is
 * tested in node. `cameraRig.ts` owns the Phaser camera and calls into this.
 *
 * §A1 lands here: at `CAMERA_ZOOM` 2.0 the visible world is 640 × 360, and the
 * clamp must be computed with that **zoomed** viewport — clamping with the design
 * resolution would let the camera show a whole screen of nothing past the map edge.
 */

export interface CameraTuning {
  viewportW: number
  viewportH: number
  zoom: number
  lerp: number
  deadzoneW: number
  deadzoneH: number
  lookahead: number
  lookaheadLerp: number
}

export interface Vec {
  x: number
  y: number
}

/** Visible world size at the current zoom. */
export function visibleSize(t: CameraTuning): { w: number; h: number } {
  return { w: t.viewportW / t.zoom, h: t.viewportH / t.zoom }
}

/**
 * Clamp a camera centre so the view stays inside the map.
 *
 * When the map is smaller than the view on an axis, the camera centres on the map
 * rather than clamping to one side — otherwise a small map sits wedged against a
 * corner with dead space on two sides.
 */
export function clampCenter(center: Vec, mapW: number, mapH: number, t: CameraTuning): Vec {
  const { w, h } = visibleSize(t)
  const half = { x: w / 2, y: h / 2 }

  const x = mapW <= w ? mapW / 2 : Math.min(Math.max(center.x, half.x), mapW - half.x)
  const y = mapH <= h ? mapH / 2 : Math.min(Math.max(center.y, half.y), mapH - half.y)
  return { x, y }
}

/**
 * Where the camera wants to be: the target, plus aim lookahead, with the deadzone
 * subtracted so small movements do not drag the view around.
 */
export function desiredCenter(
  current: Vec,
  target: Vec,
  lookahead: Vec,
  t: CameraTuning,
): Vec {
  const goal = { x: target.x + lookahead.x, y: target.y + lookahead.y }

  // Inside the deadzone the camera holds still; outside, it tracks the edge of the
  // box rather than snapping to the target, so crossing the boundary is smooth.
  const dx = goal.x - current.x
  const dy = goal.y - current.y
  const hx = t.deadzoneW / 2
  const hy = t.deadzoneH / 2

  let x = current.x
  let y = current.y
  if (dx > hx) x = goal.x - hx
  else if (dx < -hx) x = goal.x + hx
  if (dy > hy) y = goal.y - hy
  else if (dy < -hy) y = goal.y + hy

  return { x, y }
}

/** One step of exponential follow. */
export function stepCenter(current: Vec, desired: Vec, lerp: number): Vec {
  return {
    x: current.x + (desired.x - current.x) * lerp,
    y: current.y + (desired.y - current.y) * lerp,
  }
}

/** Aim-direction lead, eased toward the new value so it never snaps. */
export function stepLookahead(current: Vec, aimAngle: number | null, t: CameraTuning): Vec {
  const goal =
    aimAngle === null
      ? { x: 0, y: 0 }
      : { x: Math.cos(aimAngle) * t.lookahead, y: Math.sin(aimAngle) * t.lookahead }
  return {
    x: current.x + (goal.x - current.x) * t.lookaheadLerp,
    y: current.y + (goal.y - current.y) * t.lookaheadLerp,
  }
}

/** Trauma decay per second. */
export const TRAUMA_DECAY = 2.5

/** World px beyond which an explosion adds no trauma at all. */
export const TRAUMA_MAX_DISTANCE = 620
/** The blast this scale is calibrated against: a bazooka's 42 px. */
export const TRAUMA_REFERENCE_BLAST = 42
/** Radians of camera roll at full trauma. Small — roll reads as impact, not as a bug. */
export const TRAUMA_MAX_ROLL = 0.035

/**
 * Trauma from an explosion, by distance and blast size.
 *
 * Quadratic falloff to zero at `TRAUMA_MAX_DISTANCE`, scaled by the blast's own
 * radius so a grenade and a meteor do not shake alike. This lives beside `Trauma`
 * rather than in the feel layer because trauma is camera state, and a second copy
 * of it in another file is how this codebase ended up with two of them.
 */
export function traumaFromExplosion(distance: number, radius: number): number {
  const near = Math.max(0, 1 - Math.max(0, distance) / TRAUMA_MAX_DISTANCE)
  const weight = Math.min(1.5, radius / TRAUMA_REFERENCE_BLAST)
  return near * near * weight
}

/**
 * Trauma-based shake.
 *
 * The offset is `trauma²`, so small shakes stay subtle and large ones are
 * dramatic, and trauma is **additive and capped**, so five simultaneous explosions
 * do not multiply into an unreadable screen.
 */
export class Trauma {
  private value = 0

  add(amount: number): void {
    this.value = Math.min(1, this.value + amount)
  }

  decay(dt: number): void {
    this.value = Math.max(0, this.value - TRAUMA_DECAY * dt)
  }

  get level(): number {
    return this.value
  }

  /** Camera roll, same squared curve. Deterministic in `phase`, like `offset`. */
  roll(phase: number): number {
    const t = this.value * this.value
    if (t === 0) return 0
    return Math.sin(phase * 31.4159) * t * TRAUMA_MAX_ROLL
  }

  /** Deterministic offset, so a replay shakes identically. `phase` is a tick count. */
  offset(magnitudePx: number, phase: number): Vec {
    const t = this.value * this.value
    if (t === 0) return { x: 0, y: 0 }
    return {
      x: Math.sin(phase * 12.9898) * t * magnitudePx,
      y: Math.cos(phase * 78.233) * t * magnitudePx,
    }
  }
}
