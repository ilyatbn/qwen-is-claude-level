/**
 * T23.28: **the loading cover** — an opaque screen over the match while its map is being built.
 *
 * Owner, from `make watch`: *"when you restart the game there are several seconds when there's a map with no textures
 * visible but the player can already see it and move. it should first load fully, and only then the players should
 * see it and the round should start."* So the order is: the map arrives → the client builds and paints it **behind
 * this** → the client says `ready` → the server starts the round once every seated body has → this lifts.
 * `GameScene.coverWanted` is the rule; this is only the element.
 *
 * DOM, like every screen-space element here (a `scrollFactor(0)` Phaser object is still scaled by camera zoom, §A35).
 * Opaque on purpose: a translucent cover over an unpainted map is the frame it exists to hide. Above the HUD and the
 * results screen (z 15), below the escape menu (20), so a player can still leave from behind it.
 */
export class LoadCover {
  private root: HTMLElement | null = null

  /** Raise or lower the cover. Idempotent, so the scene can say it every frame. */
  set(up: boolean): void {
    if (up) this.ensure()
    else this.hide()
  }

  get isUp(): boolean {
    return this.root !== null
  }

  destroy(): void {
    this.hide()
  }

  private ensure(): void {
    if (this.root) return
    const el = document.createElement('div')
    el.id = 'load-cover'
    el.style.cssText =
      'position:fixed;inset:0;z-index:15;display:flex;align-items:center;justify-content:center;' +
      'background:#070b18;color:#e8ecff;pointer-events:auto;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.4rem;letter-spacing:0.15rem;'
    el.textContent = 'Loading the map…'
    document.body.appendChild(el)
    this.root = el
  }

  private hide(): void {
    this.root?.remove()
    this.root = null
  }
}
