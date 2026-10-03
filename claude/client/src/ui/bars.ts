/**
 * §C8's bottom-left cluster: health, energy and jetpack.
 *
 * DOM, like every other screen-space element (§A35). The arithmetic is in
 * `bars-math.ts` so it can be driven under node; what is here is the elements and
 * the one-way write from a snapshot to them.
 *
 * It sits **above** the HUD strip, which is a full-width band pinned to
 * `bottom:0` about 30 px tall — the jetpack readout learned that the hard way and
 * its comment in `GameScene` records the screenshot where "JET 2.2" was printed
 * over the round clock.
 */

import { consumablePips, type BarView } from './bars-math'
import { HUD_INK, HUD_SERIF, HUD_SHADOW, HUD_TRACK, installHudFont } from './hudStyle'

/** T23.21: `hudE`'s track — a hairline, 130 px in the picture; 3 px tall here so a state colour still reads. */
export const BAR_TRACK_H = 3

/**
 * One labelled track, T23.21's look (`e_style.js::hudE`): a letter-spaced serif caption, a hairline track in the
 * ink's tint with the fill in the bar's state colour (`bars-math.ts`, unchanged: health's ramp and poison, energy's
 * blue, the jet's yellow / refilling / refused), and the number after it — the number the old bar printed inside it,
 * kept (no information is lost). **The id is on the track**, so a check sampling `#hud-bar-*` measures the fill.
 */
class Bar {
  readonly row: HTMLDivElement
  readonly root: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly over: HTMLDivElement
  private readonly value: HTMLSpanElement

  constructor(doc: Document, id: string, caption: string, width: number) {
    this.row = doc.createElement('div')
    this.row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:7px;'
    const cap = doc.createElement('span')
    cap.textContent = caption
    cap.style.cssText = `width:28px;font:11px/1 ${HUD_SERIF};letter-spacing:.2em;opacity:.75;`

    this.root = doc.createElement('div')
    this.root.id = id
    this.root.style.cssText = `position:relative;width:${width}px;height:${BAR_TRACK_H}px;background:${HUD_TRACK};overflow:hidden;`
    this.fill = doc.createElement('div')
    this.fill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0;'
    this.root.appendChild(this.fill)
    // Its own element, drawn after `fill`, so the overheal band starts where the
    // base health ends instead of being blended into one colour ramp.
    this.over = doc.createElement('div')
    this.over.style.cssText = 'position:absolute;top:0;bottom:0;width:0;background:#ffc93f;'
    this.root.appendChild(this.over)

    this.value = doc.createElement('span')
    this.value.dataset['value'] = ''
    this.value.style.cssText = `min-width:34px;font:11px/1 ${HUD_SERIF};letter-spacing:.08em;opacity:.8;`
    this.row.append(cap, this.root, this.value)
  }

  set(view: BarView): void {
    this.fill.style.width = `${(view.fill * 100).toFixed(2)}%`
    this.fill.style.background = view.colour
    this.over.style.left = `${(view.fill * 100).toFixed(2)}%`
    this.over.style.width = `${(view.over * 100).toFixed(2)}%`
    this.value.textContent = view.label
  }
}

/** Heals are the health bar's red; batteries are the energy bar's blue. */
const HEAL_COLOUR = '#ff6b6b'
const BATTERY_COLOUR = '#3aa0ff'

/**
 * One consumable, as an icon, a row of pips and the number.
 *
 * The pips are `display:inline-block` blocks rather than glyphs, and that is the
 * point: T20.06's trap is that a rect mean cannot see one digit change in 13 px
 * monospace, so a fix that made the digit bigger would be unassertable *and*
 * would still not be noticeable. A filled block is both.
 */
class PipRow {
  readonly root: HTMLDivElement
  private readonly icon: HTMLSpanElement
  private readonly pips: HTMLDivElement
  private readonly value: HTMLSpanElement
  private readonly colour: string
  private built = -1
  private lastCount = -1
  private lastMax = -1

  constructor(doc: Document, id: string, key: string, colour: string) {
    this.colour = colour
    this.root = doc.createElement('div')
    this.root.id = id
    this.root.style.cssText = 'display:flex;align-items:center;gap:4px;'
    this.icon = doc.createElement('span')
    this.pips = doc.createElement('div')
    // Its own id, so a pixel check can sample the pips alone. Sampling the whole
    // row dilutes them with the icon, the digit and the key letter — measured, a
    // full row against an empty one read 13.1 that way and 40+ on the pips.
    this.pips.id = `${id}-pips`
    this.pips.style.cssText = 'display:flex;gap:2px;align-items:center;height:11px;'
    this.value = doc.createElement('span')
    const keyEl = doc.createElement('span')
    keyEl.textContent = key
    keyEl.style.cssText = 'opacity:.75;'
    this.root.appendChild(this.icon)
    this.root.appendChild(this.pips)
    this.root.appendChild(this.value)
    this.root.appendChild(keyEl)
  }

  set(icon: string, count: number, max: number): void {
    // **Nothing is written unless something changed**, and that is not a
    // micro-optimisation. `update` runs every frame, and the first version of
    // this restyled six elements with `cssText` sixty times a second where the
    // old counter wrote one `textContent`. A consumable count changes a handful
    // of times a round; the frame in between should cost nothing. `Bar.set`
    // above writes two properties for the same reason.
    if (count === this.lastCount && max === this.lastMax) return
    this.lastCount = count
    this.lastMax = max
    this.icon.textContent = icon
    const pips = consumablePips(count, max)
    // Rebuilt only when the cap changes — which it does not at runtime, but a
    // row that rebuilt every frame would throw away the elements a check has
    // just measured.
    if (this.built !== pips.length) {
      this.pips.textContent = ''
      for (let i = 0; i < pips.length; i += 1) {
        const pip = this.pips.ownerDocument.createElement('i')
        pip.dataset['pip'] = String(i)
        this.pips.appendChild(pip)
      }
      this.built = pips.length
    }
    const kids = this.pips.children
    for (let i = 0; i < pips.length; i += 1) {
      const el = kids[i] as HTMLElement | undefined
      if (!el) continue
      // An empty pip is a dark socket rather than nothing: a row that shrank
      // when you spent one would move the whole cluster, and the point of the
      // row is that its length is the cap.
      //
      // **Filled and empty are the same size**, and that is not only taste: a
      // socket a pixel smaller makes the row jitter as it fills, and it makes
      // the two states differ in geometry as well as colour — which is a check
      // that passes for a row where nothing ever lights up. `border-box` is what
      // keeps the bordered socket the same 9 px as the solid pip.
      el.style.cssText =
        'box-sizing:border-box;width:9px;height:9px;border-radius:2px;' +
        'box-shadow:0 1px 2px rgba(0,0,0,.9);' +
        (pips[i]
          ? `background:${this.colour};border:1px solid ${this.colour};`
          : // **Opaque, not translucent.** A socket at `rgba(255,255,255,.10)`
            // is the world showing through, so an empty pip over bright sky and
            // an empty pip over rock are two different colours — which is a
            // player who cannot read the row against a light background, and a
            // check whose two "identical" sockets measured 9.6 apart.
            'background:#1b2028;border:1px solid rgba(255,255,255,.30);')
    }
    this.value.textContent = String(count)
  }
}

/** The cluster. One element tree, torn down with the scene. */
export class Bars {
  readonly root: HTMLDivElement
  readonly health: HTMLDivElement
  readonly energy: HTMLDivElement
  readonly jetpack: HTMLDivElement
  private readonly bars: { health: Bar; energy: Bar; jetpack: Bar }
  /** §C9's counters, beside the health bar rather than in a slot. */
  readonly counters: HTMLDivElement
  private readonly pipRows: { heals: PipRow; batteries: PipRow }

  constructor(doc: Document = document, width = 130) {
    installHudFont(doc)
    this.root = doc.createElement('div')
    this.root.id = 'hud-bars'
    // T23.21: `hudE`'s place, left 26 — and 56 px up, which clears `#game-hud` (a ~30 px strip at bottom:0) and the
    // jetpack readout that sits at bottom:36.
    this.root.style.cssText =
      `position:fixed;left:26px;bottom:56px;z-index:12;pointer-events:none;color:${HUD_INK};text-shadow:${HUD_SHADOW};`

    // **No shield ring** (T20.08). It drew `shieldRing`'s 0..1 fraction of a 20 s
    // window, and the shield is a held generator paying per hit now — there is no
    // window and no denominator. Whether it is protecting you is the bubble on
    // your own body; how much is left is the energy bar three lines down.

    this.bars = {
      health: new Bar(doc, 'hud-bar-health', 'HP', width),
      energy: new Bar(doc, 'hud-bar-energy', 'EN', width),
      jetpack: new Bar(doc, 'hud-bar-jet', 'JET', width),
    }
    for (const b of [this.bars.health, this.bars.energy, this.bars.jetpack]) {
      this.root.appendChild(b.row)
    }
    this.health = this.bars.health.root
    this.energy = this.bars.energy.root
    this.jetpack = this.bars.jetpack.root

    // §C9: heals and batteries, **beside** the bars and not among them. They are
    // counters, not a resource with a range, so a track with a fill would be
    // saying something untrue about them.
    //
    // **Pips, not just a digit** (T20.06). The battery pack was reported as "I
    // have never seen any", and the measurement says the spawn table is not the
    // problem — it is 2nd of 19 by time on the ground. What picking one up got
    // you was `⚡ 0 R` becoming `⚡ 1 R`: one glyph, 13 px, at the edge of the
    // screen. A filled block is a change you can see without reading, and the
    // row's length says what the cap is, which the digit never did.
    this.counters = doc.createElement('div')
    this.counters.id = 'hud-consumables'
    this.counters.style.cssText =
      'position:absolute;left:100%;bottom:0;margin-left:14px;white-space:nowrap;' +
      `font:12px/1.5 ${HUD_SERIF};letter-spacing:.08em;color:${HUD_INK};text-shadow:${HUD_SHADOW};`
    this.pipRows = {
      heals: new PipRow(doc, 'hud-heals', 'Q', HEAL_COLOUR),
      batteries: new PipRow(doc, 'hud-batteries', 'R', BATTERY_COLOUR),
    }
    this.counters.appendChild(this.pipRows.heals.root)
    this.counters.appendChild(this.pipRows.batteries.root)
    this.root.style.position = 'fixed'
    this.root.appendChild(this.counters)

    doc.body.appendChild(this.root)
  }

  update(views: {
    health: BarView
    energy: BarView
    jetpack: BarView
    /**
     * The two caps ride with the counts (T20.06).
     *
     * `MAX_HEALS` and `MAX_BATTERIES` are `game-core` constants and this file is
     * the DOM half — it imports no core. Passing them in keeps the one source of
     * truth on the caller's side, where `C()` already is, rather than giving the
     * HUD a second copy of two numbers `bump` enforces.
     */
    consumables: { heals: number; batteries: number; maxHeals: number; maxBatteries: number }
  }): void {
    this.bars.health.set(views.health)
    this.bars.energy.set(views.energy)
    this.bars.jetpack.set(views.jetpack)

    // `Q` and `R` are on the labels, because a counter whose key you cannot
    // remember is a counter you do not use. The digit stays beside the pips: the
    // pips are what you see, the number is what you read.
    this.pipRows.heals.set('♥', views.consumables.heals, views.consumables.maxHeals)
    this.pipRows.batteries.set('⚡', views.consumables.batteries, views.consumables.maxBatteries)

  }

  destroy(): void {
    this.root.remove()
  }
}
