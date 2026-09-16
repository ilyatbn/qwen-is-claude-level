/**
 * The round timer and the event banner (`docs/72-amendments-v4.md` §C8).
 *
 * Two elements, both DOM and both screen-space (§A35):
 *
 * - the **round timer**, top-right, in a condensed display face, red below
 *   `TIMER_WARN_SECONDS`;
 * - the **event banner**, top-centre, red, naming the effect that is about to
 *   land or is landing and counting its time down.
 *
 * The banner is shown during **telegraph as well as active**. The telegraph is
 * the whole point of the three seconds `docs/13` §2 gives it — it is a warning,
 * and a warning that is not on the screen is not one.
 *
 * ## Why the pure half lives in this file
 *
 * Every other `ui/` module splits into `x-math.ts` and `x.ts` so the arithmetic
 * can be tested in node. This one does not need to: `vitest` runs with
 * `environment: 'node'`, and the exports below touch no DOM until `new Hud()` is
 * called, so `hud.test.ts` can import and drive them directly. The rendering is
 * asserted where rendering has to be asserted — on sampled pixels, in
 * `scripts/checks/hud-timer.mjs` (§C2).
 */

/** Effect lifecycle, as the wire spells it (`docs/40` §3). */
export type EffectPhase = 'telegraph' | 'active' | 'end'

/** What the client knows about one running effect. */
export interface EffectRun {
  id: number
  /** The wire's `kind`, e.g. `ToxicRain`. */
  kind: string
  phase: EffectPhase
  /** Round time the whole effect stops, on the server's clock. */
  endsAt: number
}

/** `MM:SS`, floored, never negative. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * What the round timer says in `phase`.
 *
 * **Nothing in `lobby`** (T21.32 item 4). `docs/74` §E1: "The map, the round timer, the
 * weather schedule and the item spawns come into existence at the moment the match
 * starts." A lobby has no round timer, and the `0:00` it drew was not a value: the lobby's
 * `time_left` is `INFINITY`, which JSON carries as `null`, which the client reads as 0.
 */
export function roundTimerText(phase: string, secondsLeft: number): string {
  return phase === 'lobby' ? '' : clockText(secondsLeft)
}

/**
 * True when the timer should be red.
 *
 * **Strictly below**, so the boundary second is not red: at exactly
 * `TIMER_WARN_SECONDS` there is still a full minute left, and the point of the
 * colour is that it means "less than a minute". `hud.test.ts` asserts both sides.
 */
export function isTimerWarning(secondsLeft: number, warnAt: number): boolean {
  return secondsLeft < warnAt
}

/**
 * The effect kind as a player should read it.
 *
 * The wire sends Rust's `Debug` — `ToxicRain`, `MeteorShower` — which is a type
 * name and not a label. Split on the case boundary rather than keeping a table:
 * a table is a second place to update when `EffectKind` gains a variant, and the
 * one that gets forgotten.
 */
export function effectLabel(kind: string): string {
  const words = kind.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : ''
}

/**
 * What the banner should say, or null when it should be down.
 *
 * `now` is the server's round time, so the countdown falls with the simulation
 * rather than with a local stopwatch — the same rule §B4 set for the death
 * countdown and §C25 for the results screen.
 *
 * When two effects overlap — `docs/13` §1 allows it — the one ending **soonest**
 * is named. The alternative is stacking banners across the top of the screen,
 * and the banner is there to be read at a glance while somebody is shooting at
 * you.
 */
export function bannerText(runs: readonly EffectRun[], now: number): string | null {
  const live = runs.filter((r) => r.phase !== 'end' && r.endsAt > now)
  if (live.length === 0) return null
  let soonest = live[0]!
  for (const r of live) if (r.endsAt < soonest.endsAt) soonest = r
  const left = clockText(soonest.endsAt - now)
  // The telegraph says what is *coming*; the active phase says what is here.
  // Same element, so the warning does not move on the screen when it lands.
  const verb = soonest.phase === 'telegraph' ? 'INCOMING' : ''
  return `${verb ? `${verb} · ` : ''}${effectLabel(soonest.kind)} ${left}`.trim()
}

/** The face is shipped in `assets/fonts/`; nothing is fetched from a CDN. */
const FONT_FAMILY = 'KenneyFutureNarrow'
const FONT_URL = '/fonts/kenney-future-narrow.ttf'
const STYLE_ID = 'hud-font'

/**
 * Install the `@font-face` once per document.
 *
 * `docs/51` §5: the game must start with no network, so the face is served from
 * our own origin like every other asset. A `<style>` rather than a `FontFace`
 * object because it is declarative, it survives a scene rebuild, and there is
 * nothing to await — the fallback stack renders until the face arrives.
 */
export function installFont(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent =
    `@font-face{font-family:'${FONT_FAMILY}';` +
    `src:url('${FONT_URL}') format('truetype');font-display:swap;}`
  doc.head.appendChild(style)
}

/**
 * The display face, with its fallback stack.
 *
 * Exported so the title and the menu use the *same* declaration the HUD does.
 * A second `@font-face` for one file is D-49's pattern, and here it would also
 * mean two answers to "what do we fall back to" — `docs/50` §8 wants one.
 */
export const DISPLAY_STACK = `'${FONT_FAMILY}',ui-monospace,SFMono-Regular,Menlo,monospace`

/** Round timer: distance from the top of the viewport, px. */
export const TIMER_TOP = 10
/** Round timer: line height, px. Its `font` size and its box are the same number. */
export const TIMER_H = 40
/**
 * Event banner: directly below the timer, **derived** from it.
 *
 * Written as arithmetic over the two constants above rather than as a literal,
 * because the whole point of the 2026-09-16 move is that the banner sits under
 * the timer — and a literal that happens to clear it today is a literal that
 * overlaps it the first time the timer's size changes. `hud.test.ts` asserts the
 * ordering rather than the number.
 */
export const BANNER_TOP = TIMER_TOP + TIMER_H + 6

/**
 * Round timer, **top-centre**; event banner directly below it.
 *
 * **Both moved 2026-09-16**, owner, from play: *"theres a list of recent
 * kills/deaths on the top right side of the screen but its hidden behind the
 * timer … lets move the timer to the top center. notifications of incoming
 * hazards shoud be below it."*
 *
 * The timer was `top:10px;right:14px` and `feelLayer`'s kill feed is
 * `right:10px;top:10px` — the same corner, and the timer is 40 px of opaque
 * display face drawn over the top of the feed. Two owners of one corner, neither
 * aware of the other; moving the timer is what frees it.
 *
 * The banner was top-centre at `top:14px`, which is where the timer now is, so it
 * moves down to clear it. `TIMER_H` is the one number both positions derive from,
 * rather than two literals that agree until one of them is edited.
 */
export class Hud {
  readonly timer: HTMLDivElement
  readonly banner: HTMLDivElement
  private readonly runs = new Map<number, EffectRun>()

  constructor(doc: Document = document) {
    installFont(doc)

    this.timer = doc.createElement('div')
    this.timer.id = 'hud-timer'
    this.timer.dataset['warn'] = '0'
    this.timer.style.cssText =
      `position:fixed;top:${TIMER_TOP}px;left:50%;transform:translateX(-50%);` +
      'z-index:12;pointer-events:none;' +
      `font:700 ${TIMER_H}px/1 ${DISPLAY_STACK};letter-spacing:1px;` +
      'color:#ffffff;text-shadow:0 2px 4px rgba(0,0,0,.85);'
    doc.body.appendChild(this.timer)

    this.banner = doc.createElement('div')
    this.banner.id = 'hud-banner'
    // `left:50%` + `translateX(-50%)` rather than `left:0;right:0;text-align`,
    // so the element is only as wide as its text. A full-width element sits over
    // the whole top of the screen and swallows nothing (it is pointer-events
    // none) but does make the empty case impossible to assert on by geometry.
    this.banner.style.cssText =
      `position:fixed;top:${BANNER_TOP}px;left:50%;transform:translateX(-50%);z-index:12;` +
      `pointer-events:none;font:700 34px/1.1 ${DISPLAY_STACK};letter-spacing:2px;` +
      'color:#ff3b30;text-shadow:0 2px 6px rgba(0,0,0,.9);display:none;'
    doc.body.appendChild(this.banner)
  }

  /** `effect_start`: a telegraph has begun. `duration` covers the whole effect. */
  startEffect(id: number, kind: string, now: number, duration: number): void {
    this.runs.set(id, { id, kind, phase: 'telegraph', endsAt: now + duration })
  }

  /** `effect_phase`: usually the move from telegraph to active. */
  setEffectPhase(id: number, phase: EffectPhase): void {
    const run = this.runs.get(id)
    if (run) run.phase = phase
  }

  /** `effect_end`. */
  endEffect(id: number): void {
    this.runs.delete(id)
  }

  /** Every effect the banner is currently considering. For the debug handle. */
  effects(): EffectRun[] {
    return [...this.runs.values()]
  }

  /**
   * Redraw from the server's clock.
   *
   * `secondsLeft` comes from the phase deadline, not from a local countdown —
   * a stopwatch drifts, and §B4 made the death countdown server-driven for
   * exactly this reason.
   */
  update(phase: string, secondsLeft: number, now: number, warnAt: number): void {
    const text = roundTimerText(phase, secondsLeft)
    // No timer, no warning: a blank lobby timer must not paint itself red.
    const warn = text !== '' && isTimerWarning(secondsLeft, warnAt)
    this.timer.textContent = text
    // A data attribute as well as the colour: a pixel check reads the colour, a
    // DOM check reads this, and the two can then be asserted against each other.
    this.timer.dataset['warn'] = warn ? '1' : '0'
    this.timer.style.color = warn ? '#ff3b30' : '#ffffff'

    // Drop finished runs here rather than trusting `effect_end` to arrive: it is
    // an event, and an event can be missed by a client that joined mid-effect.
    for (const [id, r] of this.runs) if (r.endsAt <= now) this.runs.delete(id)

    const banner = bannerText([...this.runs.values()], now)
    if (banner === null) {
      this.banner.style.display = 'none'
      this.banner.textContent = ''
    } else {
      this.banner.style.display = 'block'
      this.banner.textContent = banner
    }
  }

  destroy(): void {
    this.timer.remove()
    this.banner.remove()
    this.runs.clear()
  }
}
