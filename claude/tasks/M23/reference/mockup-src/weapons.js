// M23 arsenal in F's ink-silhouette vocabulary. Every weapon is drawn in the stick
// figure's SHOULDER frame (figure units; x = aim direction, y down), so the same
// drawing serves "held" (inside stick()) and "shown alone" (scaled up).
// Each def: draw(g, accent), grips [[x,y],[x,y]] for the two hands, muzzle [x,y], cx (visual centre x).
import * as S from './e_style.js'

const ink = () => S.INK
function poly(g, pts) { g.fillStyle = ink(); g.beginPath(); g.moveTo(...pts[0]); for (const p of pts.slice(1)) g.lineTo(...p); g.closePath(); g.fill() }
function rr(g, x, y, w, h, r) { g.fillStyle = ink(); g.beginPath(); g.roundRect(x, y, w, h, r); g.fill() }
function ln(g, a, b, w) { g.strokeStyle = ink(); g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke() }
function dot(g, x, y, r, c) { g.fillStyle = c ?? ink(); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill() }
const accentOK = a => a && !a.startsWith('rgba(') ? a : null   // rim passes pass rgba(); keep accents out of them

export const WEAPONS = {
  // ---- launchers / long guns (stock under the shoulder, two hands)
  bazooka: { grips: [[2.5, 3.5], [8, 1]], muzzle: [14, -1.2], cx: 3, draw: (g) => {
    ln(g, [-8, -1.2], [11, -1.2], 3.6); poly(g, [[10, -3.8], [14, -4.6], [14, 2.2], [10, 1.4]]); poly(g, [[-8, -3], [-10, -3.6], [-10, 1.2], [-8, 0.6]])
    rr(g, 1.5, -4.6, 3.2, 1.6, 0.5) } },
  machinegun: { grips: [[1, 2.5], [8, 1.6]], muzzle: [19, -0.6], cx: 5, draw: (g) => {
    poly(g, [[-6, -1.6], [-1, -1.4], [-1, 1.6], [-6, 2.4]]); rr(g, -1, -2.2, 11, 3.4, 0.8); ln(g, [10, -0.6], [19, -0.6], 1.3)
    rr(g, 3.5, 1.2, 3.6, 3.6, 0.6); ln(g, [2, -2.2], [7, -3.4], 1); ln(g, [7, -3.4], [8.5, -2.2], 1)       // box mag + carry handle
    ln(g, [15, 0], [13.5, 4.5], 0.8); ln(g, [15, 0], [16.8, 4.5], 0.8) } },                                 // bipod
  flamethrower: { grips: [[2.5, 3], [8, 1]], muzzle: [13.5, 0.5], cx: 4, draw: (g) => {
    ln(g, [-2, 0.5], [12.5, 0.5], 2.4); dot(g, -2, 4, 2.6); dot(g, 1.6, 4.6, 2.2); ln(g, [12.5, 0.5], [13.8, 0.5], 3.2) } },
  smg: { grips: [[3.5, 2.5], [8.5, 1]], muzzle: [13.5, -0.5], cx: 5, draw: (g) => {
    ln(g, [-3, -0.2], [2, -0.4], 1.2); rr(g, 2, -1.8, 8, 3, 0.8); ln(g, [10, -0.5], [13.5, -0.5], 1.1); rr(g, 6, 1, 1.6, 4.6, 0.4); rr(g, 3.4, 1, 1.4, 2.6, 0.4) } },
  laser_smg: { grips: [[3.5, 2.5], [9, 1]], muzzle: [15.5, -0.3], cx: 5, draw: (g, a) => {
    poly(g, [[-3, -0.6], [3, -1.8], [13, -1.2], [15.5, -0.3], [13, 1], [3, 1.4], [-3, 1]]); rr(g, 4, 1, 2, 3.6, 0.8)
    const c = accentOK(a); if (c) for (const x of [6.5, 8.5, 10.5]) { g.fillStyle = c; g.fillRect(x, -0.9, 1, 1.6) } } },
  // ---- one-handed guns (held at arm's length)
  pistol: { grips: [[9, 1.5]], muzzle: [13.5, -0.8], cx: 11, draw: (g) => { rr(g, 8.4, -1.8, 5.2, 2, 0.5); poly(g, [[8.6, -0.2], [10.4, -0.2], [9.8, 3.4], [8.2, 3.4]]) } },
  revolver: { grips: [[9, 1.5]], muzzle: [15.5, -0.9], cx: 11.5, draw: (g) => { rr(g, 9.5, -1.4, 6, 1.2, 0.4); dot(g, 10.2, -0.5, 1.6); poly(g, [[8.4, -0.6], [10, -0.4], [9.4, 3.6], [7.6, 3.2]]) } },
  deagle: { grips: [[9, 1.8]], muzzle: [15, -1], cx: 11.5, draw: (g) => { rr(g, 8.2, -2.6, 7, 3.2, 0.6); poly(g, [[8.4, 0], [10.6, 0], [10, 4], [7.8, 4]]); g.clearRect && null } },
  laser_pistol: { grips: [[9, 1.5]], muzzle: [14.5, -0.6], cx: 11, draw: (g, a) => {
    poly(g, [[8.2, -1.8], [12.5, -1.6], [14.6, -0.6], [12.5, 0.6], [10.5, 0.6], [9.8, 3.4], [8.2, 3.4]]); const c = accentOK(a); if (c) dot(g, 12.2, -0.6, 0.7, c) } },
  // ---- melee (grip in the hand, blade/head along the aim)
  knife: { grips: [[9, 1]], muzzle: [15.5, 0.4], cx: 11.5, melee: true, draw: (g) => { rr(g, 7.6, 0, 3.2, 1.8, 0.6); poly(g, [[10.8, -0.3], [15.8, 0.4], [10.8, 1.9]]) } },
  bat: { grips: [[7, 1], [9, 1]], muzzle: [19, -1], cx: 12, melee: true, draw: (g) => { poly(g, [[6, 0.4], [6, 1.6], [19, 1.4], [20, 0], [19, -1.6], [11, 0]]) } },
  axe: { grips: [[7, 1], [10, 1]], muzzle: [19, -2], cx: 12, melee: true, draw: (g) => {
    ln(g, [6, 1], [19, 0.4], 1.4); g.fillStyle = ink(); g.beginPath(); g.moveTo(16, 0.3); g.quadraticCurveTo(15.5, -4, 20, -6); g.quadraticCurveTo(21, -1, 20, 4.5); g.quadraticCurveTo(16.5, 3, 16, 0.3); g.fill() } },
  hammer: { grips: [[7, 1], [10, 1]], muzzle: [19, 0], cx: 12, melee: true, draw: (g) => { ln(g, [6, 1], [17, 0.6], 1.4); rr(g, 16.2, -3.6, 4.2, 8.4, 0.8) } },
  whip: { grips: [[9, 1]], muzzle: [36, 3], cx: 20, melee: true, draw: (g) => {
    rr(g, 7, 0, 4.6, 1.8, 0.8); g.strokeStyle = ink(); g.lineCap = 'round'
    const P = [[11.4, 0.9], [18, -2.5], [26, 2.5], [33, 1], [36.5, 3.2]]
    for (let i = 0; i < P.length - 1; i++) { g.lineWidth = 1.2 - i * 0.22; g.beginPath(); g.moveTo(...P[i]); g.quadraticCurveTo((P[i][0] + P[i + 1][0]) / 2, P[i][1] + (i % 2 ? 2.2 : -2.2), ...P[i + 1]); g.stroke() } } },
  shovel: { grips: [[4, 1.6], [8, 1]], muzzle: [20, 0], cx: 10, melee: true, draw: (g) => {
    ln(g, [1, 1.6], [15, 0.6], 1.3); ln(g, [0.5, 0.6], [0.5, 2.8], 1); poly(g, [[14.5, -2.2], [19, -2.4], [21, 0.4], [19, 3.2], [14.5, 3]]) } },
  // ---- thrown / placed (held up in the throwing hand)
  grenade: { grips: [[8, -2]], muzzle: [9.5, -3.5], cx: 9.5, thrown: true, draw: (g) => { dot(g, 9.5, -3, 2.2); rr(g, 8.6, -6.4, 1.8, 1.6, 0.3); g.strokeStyle = ink(); g.lineWidth = 0.6; g.beginPath(); g.arc(11.2, -5.8, 1.1, 0, 7); g.stroke() } },
  toxic_grenade: { grips: [[8, -2]], muzzle: [9.5, -3.5], cx: 9.5, thrown: true, draw: (g, a) => {
    rr(g, 8, -6, 3.2, 5.6, 1.4); rr(g, 8.6, -7.4, 2, 1.6, 0.3); if (a !== undefined && !String(a).startsWith('rgba(')) { g.fillStyle = '#7dff3a'; g.fillRect(8.3, -4.2, 2.6, 0.8) } } },
  smoke: { grips: [[8, -2]], muzzle: [9.5, -3.5], cx: 9.5, thrown: true, draw: (g) => { rr(g, 8, -6.8, 3.4, 6.2, 0.6); rr(g, 8.5, -8, 2.4, 1.4, 0.3); ln(g, [8.8, -5.2], [10.6, -5.2], 0.5) } },
  molotov: { grips: [[8, -2]], muzzle: [10.5, -9], cx: 9.8, thrown: true, draw: (g, a) => {
    g.fillStyle = ink(); g.beginPath(); g.roundRect(8, -5.5, 3.6, 5.2, 1.2); g.fill(); rr(g, 9.1, -8.4, 1.4, 3.2, 0.4)
    if (a !== undefined && !String(a).startsWith('rgba(')) { S.glow(g, 10.4, -9.6, 4.5, '255,150,40', 0.95); dot(g, 10.3, -9.4, 0.9, '#fff0b0') } } },
  airburst: { grips: [[8, -2]], muzzle: [9.5, -4], cx: 9.8, thrown: true, draw: (g) => { rr(g, 8, -5.2, 3.8, 4.4, 0.8); poly(g, [[8.4, -5.2], [9.9, -8.2], [11.4, -5.2]]); poly(g, [[8, -1], [6.6, 0.6], [8, 0.2]]); poly(g, [[11.8, -1], [13.2, 0.6], [11.8, 0.2]]); dot(g, 9.9, -3, 0.5, 'rgba(255,255,255,0.0)') } },
  mine: { grips: [[8, -1]], muzzle: [9.5, -2.5], cx: 9.8, thrown: true, draw: (g, a) => {
    rr(g, 6.5, -3, 6.6, 2.4, 1.1); for (const x of [7.6, 9.8, 12]) ln(g, [x, -3], [x, -4.4], 0.6); if (a !== undefined && !String(a).startsWith('rgba(')) { S.glow(g, 9.8, -3.4, 3, '255,40,30', 0.9); dot(g, 9.8, -3.3, 0.6, '#ff5040') } } },
}
export const WEAPON_ORDER = ['bazooka', 'grenade', 'smg', 'laser_pistol', 'laser_smg', 'pistol', 'revolver', 'deagle', 'machinegun', 'knife', 'bat', 'whip',
  'axe', 'hammer', 'flamethrower', 'mine', 'airburst', 'smoke', 'molotov', 'toxic_grenade', 'shovel']

/** A weapon as the `weapon` argument of S.stick(): draws the gun and the arms to its grips. */
export function held(key, accent) {
  const W = WEAPONS[key]
  return g => {
    W.draw(g, accent)
    const arm = (h, bend) => { const mx = h[0] * 0.45, my = h[1] * 0.45 + bend; S.INK && null; g.strokeStyle = S.INK; g.lineWidth = 1.8; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); g.moveTo(0, 0); g.lineTo(mx, my); g.lineTo(...h); g.stroke() }
    arm(W.grips[0], 2.8)
    arm(W.grips[1] ?? [4, 5], W.grips[1] ? 2.2 : 1)
  }
}
