/**
 * T23.14: the arsenal in F's ink vocabulary, ported from `tasks/M23/reference/mockup-src/weapons.js` — every
 * number is the mockup's. Each weapon is drawn in the stick figure's **shoulder frame** (figure units; x = the aim,
 * y down), so the same drawing is the held weapon (`figure.ts`) and, scaled up, its icon. `grips` are where the two
 * hands hold it, `muzzle` where a shot leaves, `cx` its visual centre.
 *
 * **These are F6's models** (`variant_F6.js` draws the arsenal from this same table; R26 remodelled three of them
 * apart in `weapons.js` too, so the mockup-rendered control is still lab = mockup — `F6-weapon-sheet.png` is not edited): T23.16 put F6 in the look-lab and
 * holds the firearms to it at Level A (`weapons-held`), and draws the pickups and inventory icons from these same
 * functions (`icons.ts`, R12). The item registry's keys are these keys (`items/registry.rs`, counted both ends by
 * `weapons.test.ts`); `platform_gun` is the turret prop and the sub-munitions are never held — neither has a model.
 *
 * **Glow parts** (the laser cells, a molotov's rag, a mine's lamp) are the mockup's: drawn in the accent colour in the
 * ink pass only — a rim or fill pass passes an `rgba(` colour and `accentOK` drops them, so the cell's silhouette
 * masks never hold them and the rim never tints them (T23.16: the "B channel" the task named does not exist; the
 * cell has R ink / G accent strokes, `cell.ts`). A shot's light is an effect light at the muzzle (T23.09).
 */
import { INK, glow, type G } from './draw'

type P = [number, number]

export interface WeaponDef {
  grips: P[]
  muzzle: P
  cx: number
  melee?: boolean
  thrown?: boolean
  draw(g: G, accent?: string): void
}

const ink = (): string => INK
function poly(g: G, pts: P[]): void {
  g.fillStyle = ink()
  g.beginPath()
  g.moveTo(...pts[0]!)
  for (const p of pts.slice(1)) g.lineTo(...p)
  g.closePath()
  g.fill()
}
function rr(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.fillStyle = ink()
  g.beginPath()
  g.roundRect(x, y, w, h, r)
  g.fill()
}
function ln(g: G, a: P, b: P, w: number): void {
  g.strokeStyle = ink()
  g.lineWidth = w
  g.lineCap = 'round'
  g.beginPath()
  g.moveTo(...a)
  g.lineTo(...b)
  g.stroke()
}
function dot(g: G, x: number, y: number, r: number, c?: string): void {
  g.fillStyle = c ?? ink()
  g.beginPath()
  g.arc(x, y, r, 0, 7)
  g.fill()
}
/** Rim passes pass an `rgba(` accent; accents stay out of them (`weapons.js::accentOK`). */
const accentOK = (a: string | undefined): string | null => (a && !a.startsWith('rgba(') ? a : null)

export const WEAPONS: Record<string, WeaponDef> = {
  bazooka: { grips: [[2.5, 3.5], [8, 1]], muzzle: [14, -1.2], cx: 3, draw: (g) => {
    ln(g, [-8, -1.2], [11, -1.2], 3.6); poly(g, [[10, -3.8], [14, -4.6], [14, 2.2], [10, 1.4]]); poly(g, [[-8, -3], [-10, -3.6], [-10, 1.2], [-8, 0.6]])
    rr(g, 1.5, -4.6, 3.2, 1.6, 0.5) } },
  machinegun: { grips: [[1, 2.5], [8, 1.6]], muzzle: [19, -0.6], cx: 5, draw: (g) => {
    poly(g, [[-6, -1.6], [-1, -1.4], [-1, 1.6], [-6, 2.4]]); rr(g, -1, -2.2, 11, 3.4, 0.8); ln(g, [10, -0.6], [19, -0.6], 1.3)
    rr(g, 3.5, 1.2, 3.6, 3.6, 0.6); ln(g, [2, -2.2], [7, -3.4], 1); ln(g, [7, -3.4], [8.5, -2.2], 1)
    ln(g, [15, 0], [13.5, 4.5], 0.8); ln(g, [15, 0], [16.8, 4.5], 0.8) } },
  flamethrower: { grips: [[2.5, 3], [8, 1]], muzzle: [13.5, 0.5], cx: 4, draw: (g) => {
    ln(g, [-2, 0.5], [12.5, 0.5], 2.4); dot(g, -2, 4, 2.6); dot(g, 1.6, 4.6, 2.2); ln(g, [12.5, 0.5], [13.8, 0.5], 3.2) } },
  smg: { grips: [[3.5, 2.5], [8.5, 1]], muzzle: [13.5, -0.5], cx: 5, draw: (g) => {
    ln(g, [-3, -0.2], [2, -0.4], 1.2); rr(g, 2, -1.8, 8, 3, 0.8); ln(g, [10, -0.5], [13.5, -0.5], 1.1); rr(g, 6, 1, 1.6, 4.6, 0.4); rr(g, 3.4, 1, 1.4, 2.6, 0.4) } },
  laser_smg: { grips: [[3.5, 2.5], [9, 1]], muzzle: [15.5, -0.3], cx: 5, draw: (g, a) => {
    poly(g, [[-3, -0.6], [3, -1.8], [13, -1.2], [15.5, -0.3], [13, 1], [3, 1.4], [-3, 1]]); rr(g, 4, 1, 2, 3.6, 0.8)
    const c = accentOK(a); if (c) for (const x of [6.5, 8.5, 10.5]) { g.fillStyle = c; g.fillRect(x, -0.9, 1, 1.6) } } },
  pistol: { grips: [[9, 1.5]], muzzle: [13.5, -0.8], cx: 11, draw: (g) => { rr(g, 8.4, -1.8, 5.2, 2, 0.5); poly(g, [[8.6, -0.2], [10.4, -0.2], [9.8, 3.4], [8.2, 3.4]]) } },
  revolver: { grips: [[9, 1.5]], muzzle: [15.5, -0.9], cx: 11.5, draw: (g) => { rr(g, 9.5, -1.4, 6, 1.2, 0.4); dot(g, 10.2, -0.5, 1.6); poly(g, [[8.4, -0.6], [10, -0.4], [9.4, 3.6], [7.6, 3.2]]) } },
  deagle: { grips: [[9, 1.8]], muzzle: [15, -1], cx: 11.5, draw: (g) => { rr(g, 8.2, -2.6, 7, 3.2, 0.6); poly(g, [[8.4, 0], [10.6, 0], [10, 4], [7.8, 4]]) } },
  laser_pistol: { grips: [[9, 1.5]], muzzle: [14.5, -0.6], cx: 11, draw: (g, a) => {
    poly(g, [[8.2, -1.8], [12.5, -1.6], [14.6, -0.6], [12.5, 0.6], [10.5, 0.6], [9.8, 3.4], [8.2, 3.4]]); const c = accentOK(a); if (c) dot(g, 12.2, -0.6, 0.7, c) } },
  knife: { grips: [[9, 1]], muzzle: [15.5, 0.4], cx: 11.5, melee: true, draw: (g) => { rr(g, 7.6, 0, 3.2, 1.8, 0.6); poly(g, [[10.8, -0.3], [15.8, 0.4], [10.8, 1.9]]) } },
  bat: { grips: [[7, 1], [9, 1]], muzzle: [19, -1], cx: 12, melee: true, draw: (g) => { poly(g, [[6, 0.4], [6, 1.6], [19, 1.4], [20, 0], [19, -1.6], [11, 0]]) } },
  axe: { grips: [[7, 1], [10, 1]], muzzle: [19, -2], cx: 12, melee: true, draw: (g) => {
    ln(g, [6, 1], [19, 0.4], 1.4); g.fillStyle = ink(); g.beginPath(); g.moveTo(16, 0.3); g.quadraticCurveTo(15.5, -4, 20, -6); g.quadraticCurveTo(21, -1, 20, 4.5); g.quadraticCurveTo(16.5, 3, 16, 0.3); g.fill() } },
  // R26 (T23.17): hammer, toxic_grenade and airburst remodelled apart at 1× (IoU ≤ 0.72), here and in weapons.js.
  hammer: { grips: [[7, 1], [10, 1]], muzzle: [23, 0], cx: 14, melee: true, draw: (g) => { ln(g, [6, 1], [21, 0.5], 1.4); rr(g, 20.2, -3.8, 4.4, 8.6, 0.8) } },
  whip: { grips: [[9, 1]], muzzle: [36, 3], cx: 20, melee: true, draw: (g) => {
    rr(g, 7, 0, 4.6, 1.8, 0.8); g.strokeStyle = ink(); g.lineCap = 'round'
    const Q: P[] = [[11.4, 0.9], [18, -2.5], [26, 2.5], [33, 1], [36.5, 3.2]]
    for (let i = 0; i < Q.length - 1; i++) { g.lineWidth = 1.2 - i * 0.22; g.beginPath(); g.moveTo(...Q[i]!); g.quadraticCurveTo((Q[i]![0] + Q[i + 1]![0]) / 2, Q[i]![1] + (i % 2 ? 2.2 : -2.2), ...Q[i + 1]!); g.stroke() } } },
  shovel: { grips: [[4, 1.6], [8, 1]], muzzle: [20, 0], cx: 10, melee: true, draw: (g) => {
    ln(g, [1, 1.6], [15, 0.6], 1.3); ln(g, [0.5, 0.6], [0.5, 2.8], 1); poly(g, [[14.5, -2.2], [19, -2.4], [21, 0.4], [19, 3.2], [14.5, 3]]) } },
  grenade: { grips: [[8, -2]], muzzle: [9.5, -3.5], cx: 9.5, thrown: true, draw: (g) => { dot(g, 9.5, -3, 2.2); rr(g, 8.6, -6.4, 1.8, 1.6, 0.3); g.strokeStyle = ink(); g.lineWidth = 0.6; g.beginPath(); g.arc(11.2, -5.8, 1.1, 0, 7); g.stroke() } },
  toxic_grenade: { grips: [[8, -2]], muzzle: [9.5, -3.5], cx: 9.5, thrown: true, draw: (g, a) => {
    poly(g, [[6.6, -0.4], [12.4, -0.4], [10.3, -4.8], [10.3, -7.4], [8.7, -7.4], [8.7, -4.8]]); rr(g, 8.4, -8.4, 2.2, 1.2, 0.3)
    if (a !== undefined && !String(a).startsWith('rgba(')) { g.fillStyle = '#7dff3a'; g.beginPath(); g.moveTo(7.6, -1.2); g.lineTo(11.4, -1.2); g.lineTo(10.5, -3); g.lineTo(8.5, -3); g.closePath(); g.fill() } } },
  smoke: { grips: [[8, -2]], muzzle: [9.5, -3.5], cx: 9.5, thrown: true, draw: (g) => { rr(g, 8, -6.8, 3.4, 6.2, 0.6); rr(g, 8.5, -8, 2.4, 1.4, 0.3); ln(g, [8.8, -5.2], [10.6, -5.2], 0.5) } },
  molotov: { grips: [[8, -2]], muzzle: [10.5, -9], cx: 9.8, thrown: true, draw: (g, a) => {
    g.fillStyle = ink(); g.beginPath(); g.roundRect(8, -5.5, 3.6, 5.2, 1.2); g.fill(); rr(g, 9.1, -8.4, 1.4, 3.2, 0.4)
    if (a !== undefined && !String(a).startsWith('rgba(')) { glow(g, 10.4, -9.6, 4.5, '255,150,40', 0.95); dot(g, 10.3, -9.4, 0.9, '#fff0b0') } } },
  airburst: { grips: [[8, -2]], muzzle: [9.8, -4], cx: 9.8, thrown: true, draw: (g) => { rr(g, 8.9, -6.2, 1.8, 5.4, 0.5); poly(g, [[8.9, -6.2], [9.8, -9.4], [10.7, -6.2]]); poly(g, [[8.9, -2.6], [6.2, 0.6], [8.9, -0.8]]); poly(g, [[10.7, -2.6], [13.4, 0.6], [10.7, -0.8]]) } },
  mine: { grips: [[8, -1]], muzzle: [9.5, -2.5], cx: 9.8, thrown: true, draw: (g, a) => {
    rr(g, 6.5, -3, 6.6, 2.4, 1.1); for (const x of [7.6, 9.8, 12]) ln(g, [x, -3], [x, -4.4], 0.6); if (a !== undefined && !String(a).startsWith('rgba(')) { glow(g, 9.8, -3.4, 3, '255,40,30', 0.9); dot(g, 9.8, -3.3, 0.6, '#ff5040') } } },
}

/**
 * T23.16: the registry keys by class (`items/registry.rs`, `weapons/defs.rs`): the **firearms** T23.16 remodels and
 * the **melee and thrown** T23.17 does. Every key has a model above; `weapons-held` and `weapons.test.ts` count both
 * ends. `platform_gun` (26) is the turret (`draw.ts::turret`, a prop since T23.19A) and is never held; `meteor` (3) is a
 * world event F6 skips ("never held"); the sub-munitions (4 meteor_fragment, 22 airburst_pellet, 23 toxic_drop,
 * 25 flame) are never held and have no model.
 */
export const FIREARMS = ['bazooka', 'smg', 'laser_pistol', 'laser_smg', 'pistol', 'revolver', 'deagle', 'machinegun', 'flamethrower'] as const
export const MELEE_THROWN = ['grenade', 'knife', 'bat', 'whip', 'axe', 'hammer', 'mine', 'airburst', 'smoke', 'molotov', 'toxic_grenade', 'shovel'] as const

/**
 * `weapons.js::held(key, accent)` — the weapon and the two arms to its grips, drawn in the stick's shoulder frame
 * (`draw.ts::stick`'s `weapon` drawing, F6's 1× row). Null for a key with no model.
 */
export function held(key: string, accent?: string): ((g: G) => void) | null {
  const W = WEAPONS[key]
  if (!W) return null
  return (g) => {
    W.draw(g, accent)
    const arm = (h: P, bend: number): void => {
      const mx = h[0] * 0.45
      const my = h[1] * 0.45 + bend
      g.strokeStyle = INK
      g.lineWidth = 1.8
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(mx, my)
      g.lineTo(...h)
      g.stroke()
    }
    arm(W.grips[0]!, 2.8)
    arm(W.grips[1] ?? [4, 5], W.grips[1] ? 2.2 : 1)
  }
}

/** F6's lambda: weapon `key` alone, its shoulder frame's origin at (x, y), scaled by `s` (`variant_F6.js`). */
export function drawWeapon(g: G, key: string, x: number, y: number, s: number, accent?: string): void {
  const W = WEAPONS[key]
  if (!W) return
  g.save()
  g.translate(x, y)
  g.scale(s, s)
  W.draw(g, accent)
  g.restore()
}

/**
 * A box (shoulder-frame units) no weapon's drawing leaves: back to the bazooka's rear flare (−10), up to the
 * molotov's glow (−9.6 − 4.5), down to the flamethrower's tank (4 + 2.6); forward, `muzzle + 3` or 15 (a thrown
 * weapon's glow and fins reach past its muzzle). A bound for the atlas cell, not a measurement — icons are measured.
 */
export function weaponReach(key: string): [number, number, number, number] {
  const W = WEAPONS[key]
  const fwd = Math.max((W?.muzzle[0] ?? 12) + 3, 15)
  return [-11, -14.5, fwd, 7]
}
