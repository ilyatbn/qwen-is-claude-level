/**
 * §C8's bottom-left cluster: health, energy and jetpack, with the shield ring.
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

import type { BarView } from './bars-math'

/** One labelled track. */
class Bar {
  readonly root: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly over: HTMLDivElement
  private readonly text: HTMLDivElement

  constructor(doc: Document, id: string, caption: string, width: number) {
    this.root = doc.createElement('div')
    this.root.id = id
    this.root.style.cssText =
      `position:relative;width:${width}px;height:16px;margin-top:4px;` +
      'background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.28);' +
      'border-radius:3px;overflow:hidden;'

    this.fill = doc.createElement('div')
    this.fill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0;'
    this.root.appendChild(this.fill)

    // Its own element, drawn after `fill`, so the overheal band starts where the
    // base health ends instead of being blended into one colour ramp.
    this.over = doc.createElement('div')
    this.over.style.cssText = 'position:absolute;top:0;bottom:0;width:0;background:#ffc93f;'
    this.root.appendChild(this.over)

    this.text = doc.createElement('div')
    this.text.style.cssText =
      'position:relative;height:100%;display:flex;align-items:center;' +
      'justify-content:space-between;padding:0 5px;' +
      'font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.95);'
    const cap = doc.createElement('span')
    cap.textContent = caption
    cap.style.opacity = '0.75'
    const val = doc.createElement('span')
    val.dataset['value'] = ''
    this.text.append(cap, val)
    this.root.appendChild(this.text)
  }

  set(view: BarView): void {
    this.fill.style.width = `${(view.fill * 100).toFixed(2)}%`
    this.fill.style.background = view.colour
    this.over.style.left = `${(view.fill * 100).toFixed(2)}%`
    this.over.style.width = `${(view.over * 100).toFixed(2)}%`
    const val = this.text.querySelector('[data-value]')
    if (val) val.textContent = view.label
  }
}

/** The cluster. One element tree, torn down with the scene. */
export class Bars {
  readonly root: HTMLDivElement
  readonly health: HTMLDivElement
  readonly energy: HTMLDivElement
  readonly jetpack: HTMLDivElement
  private readonly bars: { health: Bar; energy: Bar; jetpack: Bar }
  private readonly ring: HTMLDivElement

  constructor(doc: Document = document, width = 168) {
    this.root = doc.createElement('div')
    this.root.id = 'hud-bars'
    // 56 px clears `#game-hud` (a ~30 px strip at bottom:0) and the jetpack
    // readout that sits at bottom:36.
    this.root.style.cssText =
      'position:fixed;left:10px;bottom:56px;z-index:12;pointer-events:none;'

    // The ring lives above the bars rather than inside one of them: the shield is
    // a *timer*, not a pool (`docs/21` §2), and drawing it as part of the health
    // bar would say it is hit points.
    this.ring = doc.createElement('div')
    this.ring.id = 'hud-shield'
    this.ring.style.cssText =
      `width:${width}px;height:6px;margin-bottom:3px;border-radius:3px;` +
      'background:rgba(0,0,0,.5);overflow:hidden;display:none;'
    const ringFill = doc.createElement('div')
    ringFill.dataset['fill'] = ''
    ringFill.style.cssText = 'height:100%;width:0;background:#7ad7ff;'
    this.ring.appendChild(ringFill)
    this.root.appendChild(this.ring)

    this.bars = {
      health: new Bar(doc, 'hud-bar-health', 'HP', width),
      energy: new Bar(doc, 'hud-bar-energy', 'EN', width),
      jetpack: new Bar(doc, 'hud-bar-jet', 'JET', width),
    }
    for (const b of [this.bars.health, this.bars.energy, this.bars.jetpack]) {
      this.root.appendChild(b.root)
    }
    this.health = this.bars.health.root
    this.energy = this.bars.energy.root
    this.jetpack = this.bars.jetpack.root

    doc.body.appendChild(this.root)
  }

  update(views: { health: BarView; energy: BarView; jetpack: BarView; shield: number | null }): void {
    this.bars.health.set(views.health)
    this.bars.energy.set(views.energy)
    this.bars.jetpack.set(views.jetpack)

    const fill = this.ring.querySelector<HTMLElement>('[data-fill]')
    if (views.shield === null) {
      this.ring.style.display = 'none'
    } else {
      this.ring.style.display = 'block'
      if (fill) fill.style.width = `${(views.shield * 100).toFixed(2)}%`
    }
  }

  destroy(): void {
    this.root.remove()
  }
}
