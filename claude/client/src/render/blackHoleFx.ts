/**
 * T22.12 — the black hole on screen. The rules are in `blackHoleFx-math.ts`; this
 * file only paints what they decide.
 *
 * **Where**: at the position `black_hole` carried — `WorldMirror.blackHole`, sticky
 * for the round and on the results screen too (R8.4: it freezes, it stays drawn).
 * Nothing here decides where it is or whether it pulls: the pull is
 * `Core.setBlackHole` → `env_at`, and this layer is handed the same position.
 *
 * # Two render paths, one assertion
 *
 * `webgl && isHighQuality()` is one shader quad (`blackHoleFragment`): a black disc,
 * turbulent accretion light, a lensing halo. Everything else is `Graphics`: the disc,
 * a halo, turning streaks and the rings. **Both paint the disc black and the
 * accretion ring solid** in `BLACK_HOLE_RING_COLOR` just outside the horizon, and
 * `black-hole` asserts both on the rendered frame in both paths, against the same
 * instant with the layer hidden, plus a control point clear of it (§C2).
 *
 * **The telegraph** (T22.12C, R93) is `Graphics` on **both** paths: a solid ring in
 * `BLACK_HOLE_WARN_COLOR` at the horizon where the hole will open, and a thin ring
 * closing in onto it from the reach over `BLACK_HOLE_TELEGRAPH`. One picture on
 * both paths on purpose — it is a warning, not the event, and a shader for two
 * seconds would be a second thing for the check to prove.
 */

import Phaser from 'phaser'
import { C } from '../core'
import { DEPTH } from './backdrop'
import { isHighQuality } from '../ui/settings'
import {
  BLACK_HOLE_DISC_COLOR,
  BLACK_HOLE_RING_COLOR,
  BLACK_HOLE_RING_W,
  BLACK_HOLE_SPIN,
  BLACK_HOLE_STREAKS,
  BLACK_HOLE_WARN_CLOSING_ALPHA,
  BLACK_HOLE_WARN_CLOSING_W,
  BLACK_HOLE_WARN_COLOR,
  BLACK_HOLE_WARN_W,
  type BlackHoleRadii,
  blackHoleGrowth,
  blackHoleRadii,
  rgbOf,
  streakPhase,
  warnClosingRadius,
  warnProgress,
} from './blackHoleFx-math'

/** The hole to draw — `WorldMirror`'s `BlackHoleView`, structurally. */
export interface BlackHoleDraw {
  x: number
  y: number
  arrivedAt: number
}

/** The telegraph to draw — `WorldMirror`'s `BlackHoleWarnView`, structurally. */
export interface BlackHoleWarnDraw {
  x: number
  y: number
  since: number
  opensAt: number
}

/** What the last `update` drew — read back by the checks, never the setting (§A39). */
export interface BlackHoleFxState {
  drawn: boolean
  shader: boolean
  /** Frames in which it was painted. */
  frames: number
  hidden: boolean
  /** 0 → 1 while its decoration swells in on arrival (the disc and ring never do, T22.14A). */
  growth: number
  /** The accretion ring's colour, 0–255 — what a check expects at the ring. */
  ringRgb: [number, number, number]
  radii: BlackHoleRadii
  /** R93: the telegraph was painted this frame (the hole is not here yet). */
  warned: boolean
  /** 0 → 1 through the telegraph. */
  warnProgress: number
  /** The telegraph ring's colour, 0–255, and where it is. */
  warnRgb: [number, number, number]
  warnAt: { x: number; y: number } | null
}

/**
 * The shader path. `resolution` and `time` are Phaser's own uniforms; the quad is
 * `2 × glow` square, centred on the hole, so `p` below is world px from the centre.
 */
function blackHoleFragment(): string {
  return /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 resolution;
uniform float time;
uniform float horizon;
uniform float ring;
uniform float ringW;
uniform float glow;
uniform float spin;
uniform float grow;
uniform vec3 ringCol;

varying vec2 fragCoord;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 q) {
  vec2 i = floor(q); vec2 f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  // T22.14A L: the disc and the ring are the rule (R90) and are full size from the
  // arrival — the server kills at the full horizon on that tick — so they are drawn
  // at the true radius r0. Only the decoration (accretion light, halo) swells in:
  // it is drawn at the scaled radius r, and multiplied by step(0.001, grow).
  vec2 p0 = vec2(fragCoord.x, resolution.y - fragCoord.y) - resolution * 0.5;
  float r0 = length(p0);
  if (r0 > glow) { gl_FragColor = vec4(0.0); return; }
  vec2 p = p0 / max(grow, 0.001);
  float r = length(p);
  float a = atan(p.y, p.x);
  // Accretion light: hot turbulent bands swirling just outside the horizon.
  float band = 1.0 - smoothstep(horizon, horizon * 2.2, r);
  // Sampled on the circle (cos, sin), not on the angle, so there is no seam where
  // atan wraps at ±pi (the first cut showed one, measured by eye on the screenshot).
  float ang = a + spin * time * (horizon / max(r, 1.0));
  float swirl = 0.5 * (noise(vec2(cos(ang), sin(ang)) * 4.0 + vec2(r * 0.06, -time * 0.5))
    + noise(vec2(cos(2.0 * ang), sin(2.0 * ang)) * 3.0 - vec2(time * 0.3, r * 0.04)));
  float hot = band * (0.35 + 0.65 * swirl) * step(horizon, r);
  vec3 hotCol = mix(vec3(0.85, 0.25, 0.05), vec3(1.0, 0.9, 0.6), swirl * band);
  // Lensing halo, fading to nothing at the glow's edge; brighter toward the horizon.
  float halo = pow(1.0 - smoothstep(horizon, glow, r), 3.0) * 0.35;
  float deco = step(0.001, grow) * step(r, glow);
  vec3 col = (hotCol * hot + vec3(1.0, 0.55, 0.25) * halo) * deco;
  float alpha = clamp(hot + halo, 0.0, 1.0) * deco;
  // The accretion ring: solid across ringW — the probe band. Full size (r0).
  float rg = 1.0 - smoothstep(ringW * 0.5, ringW * 0.5 + 1.0, abs(r0 - ring));
  col = mix(col, ringCol, rg);
  alpha = max(alpha, rg);
  // The horizon: black, opaque, to its edge. Full size (r0).
  float disc = 1.0 - smoothstep(horizon - 1.0, horizon, r0);
  col = mix(col, vec3(0.0), disc);
  alpha = max(alpha, disc);
  gl_FragColor = vec4(col * alpha, alpha);
}
`
}

export class BlackHoleFx {
  private readonly gfx: Phaser.GameObjects.Graphics
  private readonly glow: Phaser.GameObjects.Graphics
  private quad: Phaser.GameObjects.Shader | null = null
  private hidden = false
  private frames = 0
  private last: BlackHoleFxState

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly webgl: boolean,
  ) {
    // At the particles' depth, beside the vortices and the flare: over the rock and
    // the players, under the HUD. **Not a new depth** — `sceneDepths()` is pinned.
    this.glow = scene.add.graphics().setDepth(DEPTH.particles).setBlendMode(Phaser.BlendModes.ADD)
    this.gfx = scene.add.graphics().setDepth(DEPTH.particles)
    this.last = this.stateOf(false, false, 0)
  }

  /**
   * One frame. `nowMs` is `performance.now()` (the clock `arrivedAt`, `since` and
   * `opensAt` are on); `t` turns the streaks. `warn` is drawn only while `hole` is not.
   */
  update(hole: BlackHoleDraw | null, warn: BlackHoleWarnDraw | null, nowMs: number, t: number): void {
    this.gfx.clear()
    this.glow.clear()
    const viaShader = this.webgl && isHighQuality()
    let drawn = false
    let growth = 0
    let warned = false
    let progress = 0
    if (hole && !this.hidden) {
      // T22.14A L: drawn from the arrival frame on — the disc and ring at full size
      // (the server kills at the full horizon on arrival); `growth` swells in only the
      // decoration.
      growth = blackHoleGrowth(hole.arrivedAt, nowMs)
      drawn = true
      const r = blackHoleRadii(C())
      if (viaShader) this.paintShader(hole, growth, r)
      else this.paintFlat(hole, growth, r, t)
    } else if (!hole && warn && !this.hidden) {
      progress = warnProgress(warn.since, warn.opensAt, nowMs)
      this.paintWarn(warn, progress, blackHoleRadii(C()))
      warned = true
    }
    if (!(drawn && viaShader)) this.dropQuad()
    if (drawn) this.frames++
    this.last = this.stateOf(drawn, viaShader && drawn, growth, warned, progress, warned && warn ? warn : null)
  }

  /** e2e only (§C2): hide the layer for a same-instant control frame. */
  setHidden(on: boolean): void {
    this.hidden = on
    if (on) {
      this.gfx.clear()
      this.glow.clear()
      this.dropQuad()
    }
  }

  get state(): BlackHoleFxState {
    return {
      ...this.last,
      ringRgb: [...this.last.ringRgb],
      radii: { ...this.last.radii },
      warnRgb: [...this.last.warnRgb],
      warnAt: this.last.warnAt ? { ...this.last.warnAt } : null,
    }
  }

  /** A new round: nothing drawn; the position itself is the mirror's to clear. */
  clear(): void {
    this.dropQuad()
    this.gfx.clear()
    this.glow.clear()
  }

  destroy(): void {
    this.clear()
    this.gfx.destroy()
    this.glow.destroy()
  }

  private stateOf(
    drawn: boolean,
    shader: boolean,
    growth: number,
    warned = false,
    progress = 0,
    warnAt: { x: number; y: number } | null = null,
  ): BlackHoleFxState {
    return {
      drawn,
      shader,
      frames: this.frames,
      hidden: this.hidden,
      growth,
      ringRgb: rgbOf(BLACK_HOLE_RING_COLOR),
      radii: blackHoleRadii(C()),
      warned,
      warnProgress: progress,
      warnRgb: rgbOf(BLACK_HOLE_WARN_COLOR),
      warnAt: warnAt ? { x: warnAt.x, y: warnAt.y } : null,
    }
  }

  /** R93: the solid ring where it will open, and the ring closing in onto it. */
  private paintWarn(w: BlackHoleWarnDraw, u: number, r: BlackHoleRadii): void {
    this.gfx.lineStyle(BLACK_HOLE_WARN_CLOSING_W, BLACK_HOLE_WARN_COLOR, BLACK_HOLE_WARN_CLOSING_ALPHA)
    this.gfx.strokeCircle(w.x, w.y, warnClosingRadius(r, u))
    this.gfx.lineStyle(BLACK_HOLE_WARN_W, BLACK_HOLE_WARN_COLOR, 1)
    this.gfx.strokeCircle(w.x, w.y, r.horizon)
  }

  private dropQuad(): void {
    this.quad?.destroy()
    this.quad = null
  }

  private paintFlat(h: BlackHoleDraw, grow: number, r: BlackHoleRadii, t: number): void {
    const s = grow
    // The lensing halo, in rings of falling light out to the glow's edge (T22.18: not
    // the reach, which R106 doubled — `BLACK_HOLE_GLOW_HORIZONS`).
    for (let i = 0; i < 6; i++) {
      const u = i / 6
      this.glow.fillStyle(0xff7a30, 0.05 * (1 - u))
      this.glow.fillCircle(h.x, h.y, (r.horizon + (r.glow - r.horizon) * (1 - u)) * s)
    }
    // Accretion streaks: short hot arcs turning round the ring.
    for (let k = 0; k < BLACK_HOLE_STREAKS; k++) {
      const a0 = streakPhase(k, t)
      for (const [w, color, alpha, rr] of [
        [10, 0xff6a1a, 0.35, r.ring + 10],
        [4, 0xffe0a0, 0.7, r.ring + 7],
      ] as const) {
        this.glow.lineStyle(w * s, color, alpha)
        this.glow.beginPath()
        this.glow.arc(h.x, h.y, rr * s, a0, a0 + 0.9, false)
        this.glow.strokePath()
      }
    }
    // The accretion ring, solid — the probe band — then the horizon, black to its edge.
    // **Full size from the arrival** (T22.14A L): they are the rule, not decoration.
    this.gfx.lineStyle(BLACK_HOLE_RING_W, BLACK_HOLE_RING_COLOR, 1)
    this.gfx.strokeCircle(h.x, h.y, r.ring)
    this.gfx.fillStyle(BLACK_HOLE_DISC_COLOR, 1)
    this.gfx.fillCircle(h.x, h.y, r.horizon)
  }

  private paintShader(h: BlackHoleDraw, grow: number, r: BlackHoleRadii): void {
    if (!this.quad) {
      const [rr, rg, rb] = rgbOf(BLACK_HOLE_RING_COLOR)
      const base = new Phaser.Display.BaseShader('blackHole', blackHoleFragment(), undefined, {
        horizon: { type: '1f', value: r.horizon },
        ring: { type: '1f', value: r.ring },
        ringW: { type: '1f', value: BLACK_HOLE_RING_W },
        glow: { type: '1f', value: r.glow },
        spin: { type: '1f', value: BLACK_HOLE_SPIN },
        grow: { type: '1f', value: grow },
        ringCol: { type: '3f', value: { x: rr / 255, y: rg / 255, z: rb / 255 } },
      })
      this.quad = this.scene.add
        .shader(base, 0, 0, r.glow * 2, r.glow * 2)
        .setOrigin(0.5, 0.5)
        .setDepth(DEPTH.particles)
    }
    this.quad.setUniform('grow.value', grow)
    this.quad.setPosition(h.x, h.y).setVisible(true)
  }
}
