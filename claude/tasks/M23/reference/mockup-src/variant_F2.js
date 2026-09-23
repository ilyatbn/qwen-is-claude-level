// F2: volcanic night — same system, different palette: ash sky, lava glow from below, glowing seams.
import { combatF } from './f_scene.js'
export default async function () {
  combatF({
    theme: 'volcanic', timer: '1:34',
    bg: { skyTop: 0x0b0707, skyBottom: 0x2e1712, haze: 0x44201a, horizon: 500, grainK: 0.025, glowY: 500, glowColor: 0x2a0a04, layers: [
      { shape: 'mesa', x: 1000, y: 120, slope: 0.9, top: 60, color: 0x33201d, step: 6, soft: 2.8, fade: [200, 490, 0.5], jitter: 1.1 },
      { shape: 'zig', x: 300, y: 180, slope: 0.9, top: 50, color: 0x271816, step: 7, soft: 1.8, fade: [240, 495, 0.5], jitter: 0.6 },
      { shape: 'pyramid', x: 820, y: 170, slope: 1.2, color: 0x1f100e, step: 5, soft: 1.0, fade: [260, 500, 0.55], jitter: 0.9 },
    ] },
    terrain: { sunDir: [-0.3, -0.5, 0.5], sunCol: [0.35, 0.1, 0.03], sky: [0.04, 0.025, 0.02], ground: [0.12, 0.03, 0.01], rimCol: [1.0, 0.35, 0.1], rimK: 0.45, lipK: 0.08, lipCol: [0.9, 0.5, 0.35], interior: 0.5, bevel: 14, lava: [1.6, 0.45, 0.08], lavaK: 0.6 },
    fogBack: { color: [0.3, 0.08, 0.03], y0: 380, y1: 540, k: 0.6 },
    fogFront: { color: [0.25, 0.06, 0.02], y0: 600, y1: 720, k: 0.4, seed: 5 },
    fg: { tint: [0.006, 0.003, 0.003], spots: [{ x: -10, y: 560, r: 90, n: 9 }, { x: 1300, y: 700, r: 110, n: 10 }] },
    moon: { dx: 0.2, dy: 1, rgb: '255,120,60', w: 0.65, fill: '120,60,50' },
    teamA: '#f2ece0', teamB: '#20c8ff', fire: '255,140,50', laser: '40,200,255', muzzle: '255,200,110', gate: '255,190,120', crystal: '255,90,40',
    gateAccent: '#ffb070', gateInner: 'rgba(30,14,10,0.9)', halo: '200,90,60',
    smoke: { rgb: '60,40,36', a: 0.2, size: 6 }, plume: 0x140c0a,
    bloom: [0.65, 0.5, 0.68], grade: { vignette: 0.6, sat: 1.05 }, exposure: 1.1,
    extra2d: 'embers',
  })
}
