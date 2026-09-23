/**
 * §C12's debug mode: `F1` or `?debug=1`, **off by default**.
 *
 * One toggle, not two. The F4 overlays from T3.11 are folded in here rather than
 * left beside it — two mechanisms for one job is how they drift, and the state
 * that decides whether collision boxes are drawn should be the same state that
 * decides whether the aim ring is.
 *
 * ## What it must not do
 *
 * Change the simulation. Nothing in this file touches input, physics or the
 * network; it decides what is *drawn*. `debug-mode.mjs` asserts that by running a
 * fixed input sequence with it on and off and comparing the resulting positions.
 */

/** Where the flag survives a scene change. */
export const DEBUG_MODE_KEY = 'debug-mode'
const KEY = DEBUG_MODE_KEY

/**
 * Frames per second, from `requestAnimationFrame` deltas.
 *
 * **Not `game.loop.actualFps`.** §A38 diagnosed a "performance regression" that
 * was this counter lying: Phaser's figure is a smoothed average that
 * under-reports for seconds after a stall, so it says the frame rate is bad long
 * after it has recovered and says it is fine during a short one. The median of a
 * short window of real deltas does neither.
 */
export class FpsMeter {
  private readonly deltas: number[] = []
  private last = 0

  constructor(private readonly window = 30) {}

  /** Feed a frame timestamp, in ms. Ignores the first, which has no delta. */
  sample(nowMs: number): void {
    if (this.last > 0) {
      const dt = nowMs - this.last
      if (dt > 0) {
        this.deltas.push(dt)
        if (this.deltas.length > this.window) this.deltas.shift()
      }
    }
    this.last = nowMs
  }

  /**
   * The median frame rate over the window, or 0 before there is one.
   *
   * The median, not the mean: one 200 ms hitch in thirty frames drags a mean
   * from 60 to 48 and reports a stutter that lasted a sixtieth of a second as if
   * it were the frame rate.
   */
  fps(): number {
    if (this.deltas.length === 0) return 0
    const sorted = [...this.deltas].sort((a, b) => a - b)
    const mid = sorted[Math.floor(sorted.length / 2)]!
    return mid > 0 ? 1000 / mid : 0
  }

  reset(): void {
    this.deltas.length = 0
    this.last = 0
  }
}

/** Read `?debug=1` (or `?debug`) from a URL. */
export function debugFromQuery(search: string): boolean {
  const p = new URLSearchParams(search)
  if (!p.has('debug')) return false
  const v = p.get('debug')
  return v === null || v === '' || v === '1' || v === 'true'
}

/**
 * Whether debug mode comes up on: the query parameter, or the flag left behind
 * by the last scene.
 *
 * Its own function because "survives a scene change" is a claim about
 * *construction*, and construction is where a browser check cannot reach without
 * reloading the page — which is a different thing, and one that drops the seat.
 */
export function initialEnabled(search: string, stored: string | null): boolean {
  return debugFromQuery(search) || stored === '1'
}

export interface DebugModeDeps {
  /** Show or hide the aim ring. The crosshair itself always stays (§C12). */
  setAimRing(on: boolean): void
  /** The T3.11 overlays: collision boxes, chunk bounds, surface points. */
  setOverlays(on: boolean): void
}

export class DebugMode {
  readonly fpsMeter = new FpsMeter()
  private on: boolean
  private readonly readout: HTMLDivElement

  constructor(
    private readonly deps: DebugModeDeps,
    search = typeof location === 'undefined' ? '' : location.search,
    private readonly store: Pick<Storage, 'getItem' | 'setItem'> | null =
      typeof sessionStorage === 'undefined' ? null : sessionStorage,
    doc: Document = document,
  ) {
    // The query parameter wins on first load; after that the stored flag carries
    // it across a scene change, which §C12 asks for in as many words.
    this.on = initialEnabled(search, this.store?.getItem(KEY) ?? null)

    this.readout = doc.createElement('div')
    this.readout.id = 'debug-fps'
    this.readout.style.cssText =
      'position:fixed;top:8px;left:10px;z-index:14;pointer-events:none;display:none;' +
      'font:700 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#8cff8c;text-shadow:0 1px 2px rgba(0,0,0,.9);'
    doc.body.appendChild(this.readout)

    this.apply()
  }

  get enabled(): boolean {
    return this.on
  }

  toggle(on = !this.on): boolean {
    this.on = on
    this.store?.setItem(KEY, on ? '1' : '0')
    this.apply()
    return this.on
  }

  /** Per frame. Costs a push and a shift when off, and nothing else. */
  update(nowMs: number): void {
    this.fpsMeter.sample(nowMs)
    if (this.on) this.readout.textContent = `${this.fpsMeter.fps().toFixed(0)} fps`
  }

  destroy(): void {
    this.readout.remove()
  }

  private apply(): void {
    this.readout.style.display = this.on ? 'block' : 'none'
    // The **ring** goes in normal play; the crosshair stays, because it is the
    // aiming affordance and not a development one (§C12).
    this.deps.setAimRing(this.on)
    this.deps.setOverlays(this.on)
  }
}
