/**
 * T22.10B — the breach vortex on screen. The rules are in `vortexFx-math.ts`; this
 * file only paints what they decide.
 *
 * **Where**: at the position `vortex_open` carried — the list is the mirror's
 * (`WorldMirror.vortices`), in the server's opening order; the sandbox keeps its own.
 * Nothing here decides where a vortex is or whether it pulls: the pull is
 * `Core.setVortices` → `env_at`, and this layer is handed the same list.
 *
 * **Not on the minimap** (`M22-RULINGS` R9, point 5): it is a secret. `Minimap`
 * is never handed this list, and `breach-vortex` photographs the minimap to say so.
 *
 * # Two render paths, one assertion
 *
 * `webgl && isHighQuality()` is a shader quad per vortex (`vortexFragment`);
 * everything else is `Graphics`: a dark core, spiral arms, and the capture ring.
 * **Both paint the capture ring solid**, at `VORTEX_CAPTURE_R` — what takes you —
 * and `breach-vortex` asserts it on the rendered frame in both paths, against the
 * same instant with the layer hidden, plus a control point clear of it (§C2).
 *
 * A vortex that stopped pulling (`vortex_close`, R88) fades over `VORTEX_FADE_MS`.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'
import { isHighQuality } from '../ui/settings'
import { VORTEX_ARMS, VORTEX_RING_COLOR, VORTEX_RING_W, armPhase, rgbOf, spiralArm, vortexFade, vortexRadii } from './vortexFx-math'

/** One vortex to draw — `WorldMirror`'s `VortexView`, structurally. */
export interface VortexDraw {
  id: number
  x: number
  y: number
  closedAt: number | null
}

/** What the last `update` drew — read back by the checks, never the setting (§A39). */
export interface VortexFxState {
  /** Ids painted this frame (pulling or fading). */
  drawn: number[]
  shader: boolean
  /** Frames in which anything was painted. */
  frames: number
  hidden: boolean
  /** The capture ring's colour, 0–255 — what a check expects at the ring. */
  ringRgb: [number, number, number]
}

/**
 * The shader path: polar swirl, a dark core, the capture ring. `resolution` and
 * `time` are Phaser's own uniforms; the quad is `2 × outer` square, centred on the
 * vortex, so `p` below is world px from the centre.
 */
function vortexFragment(): string {
  return /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 resolution;
uniform float time;
// VORTEX_CAPTURE_R and VORTEX_REACH / 2, world px.
uniform float capture;
uniform float outer;
uniform float ringW;
uniform float strength;
uniform float arms;
uniform float spin;
uniform vec3 ringCol;

varying vec2 fragCoord;

void main() {
  vec2 p = vec2(fragCoord.x, resolution.y - fragCoord.y) - resolution * 0.5;
  float r = length(p);
  if (r > outer) { gl_FragColor = vec4(0.0); return; }
  float a = atan(p.y, p.x);
  // Logarithmic arms turning inward, brightest near the ring, gone at the edge.
  float wind = log(max(r, 1.0) / (capture * 0.25)) / log(outer / (capture * 0.25));
  float arm = 0.5 + 0.5 * sin(arms * (a - 6.2831853 * 1.25 * wind) + spin * time * arms);
  arm = pow(arm, 4.0);
  float reach = 1.0 - smoothstep(capture, outer, r);
  float swirl = arm * reach;
  // The ring: solid across ringW, so the probe band is painted whatever the swirl does.
  float ring = 1.0 - smoothstep(ringW * 0.5, ringW * 0.5 + 1.5, abs(r - capture));
  float core = 1.0 - smoothstep(capture * 0.55, capture * 0.75, r);
  vec3 armCol = mix(vec3(0.45, 0.15, 0.95), vec3(0.35, 0.95, 1.0), arm);
  vec3 col = armCol * swirl;
  col = mix(col, vec3(0.03, 0.0, 0.07), core);
  col = mix(col, ringCol, ring);
  float alpha = max(max(swirl * 0.85, core * 0.92), ring);
  gl_FragColor = vec4(col * alpha, alpha) * strength;
}
`
}

export class VortexFx {
  private readonly gfx: Phaser.GameObjects.Graphics
  private readonly glow: Phaser.GameObjects.Graphics
  private readonly quads = new Map<number, Phaser.GameObjects.Shader>()
  private readonly arm: number[] = []
  private hidden = false
  private frames = 0
  private last: VortexFxState = { drawn: [], shader: false, frames: 0, hidden: false, ringRgb: rgbOf(VORTEX_RING_COLOR) }

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly webgl: boolean,
  ) {
    // At the particles' depth, beside the flare: over the rock and the players, under
    // the HUD. **Not a new depth** — `sceneDepths()` is pinned by `terrain-render`.
    this.glow = scene.add.graphics().setDepth(DEPTH.particles).setBlendMode(Phaser.BlendModes.ADD)
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
  }

  /** One frame. `nowMs` is `performance.now()` (the clock `closedAt` is on); `t` stirs the swirl. */
  update(list: readonly VortexDraw[], nowMs: number, t: number): void {
    this.gfx.clear()
    this.glow.clear()
    const viaShader = this.webgl && isHighQuality()
    const drawn: number[] = []
    const used = new Set<number>()
    if (!this.hidden) {
      const radii = vortexRadii(C())
      for (const v of list) {
        const fade = vortexFade(v.closedAt, nowMs)
        if (fade <= 0) continue
        drawn.push(v.id)
        if (viaShader) {
          this.paintShader(v, fade, radii)
          used.add(v.id)
        } else this.paintFlat(v, fade, radii, t)
      }
    }
    for (const [id, q] of this.quads) {
      if (!used.has(id)) {
        q.destroy()
        this.quads.delete(id)
      }
    }
    if (drawn.length) this.frames++
    this.last = { drawn, shader: viaShader && drawn.length > 0, frames: this.frames, hidden: this.hidden, ringRgb: rgbOf(VORTEX_RING_COLOR) }
  }

  /** e2e only (§C2): hide the layer for a same-instant control frame. */
  setHidden(on: boolean): void {
    this.hidden = on
    if (on) {
      this.gfx.clear()
      this.glow.clear()
      for (const q of this.quads.values()) q.destroy()
      this.quads.clear()
    }
  }

  get state(): VortexFxState {
    return { ...this.last, drawn: [...this.last.drawn], ringRgb: [...this.last.ringRgb] }
  }

  /** Discard the round's quads; the list itself is the mirror's to clear. */
  clear(): void {
    for (const q of this.quads.values()) q.destroy()
    this.quads.clear()
    this.gfx.clear()
    this.glow.clear()
  }

  destroy(): void {
    this.clear()
    this.gfx.destroy()
    this.glow.destroy()
  }

  private paintFlat(v: VortexDraw, fade: number, r: { capture: number; outer: number }, t: number): void {
    const g = this.gfx
    const inner = r.capture * 0.25
    // A faint violet halo out to where thrust stops winning.
    this.glow.fillStyle(0x5020a0, 0.16 * fade)
    this.glow.fillCircle(v.x, v.y, r.outer)
    // The arms, added so they glow over the dark.
    for (let k = 0; k < VORTEX_ARMS; k++) {
      spiralArm(v.x, v.y, inner, r.outer, armPhase(k, t), this.arm)
      for (const [w, color, alpha] of [
        [9, 0x6a2cff, 0.35],
        [3, 0x78f0ff, 0.8],
      ] as const) {
        this.glow.lineStyle(w, color, alpha * fade)
        this.glow.beginPath()
        this.glow.moveTo(this.arm[0]!, this.arm[1]!)
        for (let i = 2; i + 1 < this.arm.length; i += 2) this.glow.lineTo(this.arm[i]!, this.arm[i + 1]!)
        this.glow.strokePath()
      }
    }
    // The dark core, then the ring that takes you — solid, the probe band.
    g.fillStyle(0x080012, 0.92 * fade)
    g.fillCircle(v.x, v.y, r.capture * 0.7)
    g.lineStyle(VORTEX_RING_W, VORTEX_RING_COLOR, fade)
    g.strokeCircle(v.x, v.y, r.capture)
  }

  private paintShader(v: VortexDraw, fade: number, r: { capture: number; outer: number }): void {
    let q = this.quads.get(v.id)
    if (!q) {
      const base = new Phaser.Display.BaseShader(`vortex${v.id}`, vortexFragment(), undefined, {
        capture: { type: '1f', value: r.capture },
        outer: { type: '1f', value: r.outer },
        ringW: { type: '1f', value: VORTEX_RING_W },
        strength: { type: '1f', value: 1 },
        arms: { type: '1f', value: VORTEX_ARMS },
        spin: { type: '1f', value: 1 },
        ringCol: { type: '3f', value: { x: rgbOf(VORTEX_RING_COLOR)[0] / 255, y: rgbOf(VORTEX_RING_COLOR)[1] / 255, z: rgbOf(VORTEX_RING_COLOR)[2] / 255 } },
      })
      q = this.scene.add
        .shader(base, 0, 0, r.outer * 2, r.outer * 2)
        .setOrigin(0.5, 0.5)
        .setDepth(DEPTH.particles)
      this.quads.set(v.id, q)
    }
    q.setUniform('strength.value', fade)
    q.setPosition(v.x, v.y).setVisible(true)
  }
}
