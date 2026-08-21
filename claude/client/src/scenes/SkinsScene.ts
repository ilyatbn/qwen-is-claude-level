/**
 * The skins menu (`docs/71-amendments-v3.md` §B3).
 *
 * The chooser is DOM and the previews are Phaser, for the reason §A35 gives:
 * a `scrollFactor(0)` object is still scaled by camera zoom, so screen-space UI
 * does not belong in the world — but a *preview of a game object* does, because
 * it has to be drawn by the same code that draws it in the game. Rendering the
 * character here through anything other than `PlayerView` would make this screen
 * advertise a character the game does not draw (§B12).
 *
 * Selection and persistence live in `ui/skins.ts`, which is Phaser-free.
 */
import Phaser from 'phaser'
import { C, Core } from '../core'
import { loadAssetManifest, runLoader, skins } from '../render/assets'
import { PlayerView } from '../render/playerView'
import { ensureTombstoneTextures, TOMBSTONE_ART, tombstoneArt } from '../render/tombstoneTextures'
import { ensureWeaponTextures, weaponArt } from '../render/weaponTextures'
import {
  cycle,
  loadChoice,
  saveChoice,
  weaponSlots,
  type Choice,
  type WeaponSlot,
} from '../ui/skins'

/** Walking speed fed to the preview, so the cycle runs at its natural rate. */
const PREVIEW_VX = 90

/** Weapon keys shown greyed out. Read from the registry so it cannot drift. */
function arsenalKeys(): string[] {
  const reg = skins()
  const fromRegistry = (reg?.weapons ?? []).map((w) => w.weaponKey)
  // The registry is the source of truth, but it can be absent entirely when the
  // game is running on fallbacks (`docs/50` §8) — and an empty "Coming soon"
  // section reads as a bug rather than as a promise.
  return fromRegistry.length > 0 ? fromRegistry : ['bazooka', 'grenade', 'smg']
}

export class SkinsScene extends Phaser.Scene {
  private choice: Choice = { name: 'Player', skinId: 0, tombstoneSkinId: 0 }
  private root: HTMLElement | null = null
  private preview: PlayerView | null = null
  private stone: Phaser.GameObjects.Image | null = null
  private weaponRow: Phaser.GameObjects.GameObject[] = []
  private slots: WeaponSlot[] = []
  private skinCount = 1
  private t = 0

  constructor() {
    super('Skins')
  }

  async create(): Promise<void> {
    // Same atlases the game loads. Without this every preview falls back to a
    // placeholder box — correct behaviour, and exactly the §B12 trap: the code
    // would be right and the picture would be five identical grey rectangles.
    await loadAssetManifest(this)
    await runLoader(this)
    await Core.init()

    ensureTombstoneTextures(this.textures)
    ensureWeaponTextures(this.textures)

    this.skinCount = Math.max(1, skins()?.players.length ?? 1)
    this.choice = loadChoice(localStorage, this.skinCount, TOMBSTONE_ART.length)
    this.slots = weaponSlots(arsenalKeys())

    this.cameras.main.setBackgroundColor('#141922')
    this.buildStage()
    this.buildDom()
    this.render()

    this.input.keyboard?.on('keydown-ESC', () => this.back())
    this.input.keyboard?.on('keydown-LEFT', () => this.step('skinId', -1))
    this.input.keyboard?.on('keydown-RIGHT', () => this.step('skinId', 1))
    this.input.keyboard?.on('keydown-UP', () => this.step('tombstoneSkinId', -1))
    this.input.keyboard?.on('keydown-DOWN', () => this.step('tombstoneSkinId', 1))

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.root?.remove()
      this.root = null
      this.preview = null
      this.stone = null
      this.weaponRow = []
    })
    this.exposeDebugHandle()
  }

  /** The character, the grave and the greyed-out arsenal, all as game objects. */
  private buildStage(): void {
    const cam = this.cameras.main
    const midY = cam.height * 0.46

    this.rebuildCharacter(cam.width * 0.34, midY)

    const art = tombstoneArt(this.choice.tombstoneSkinId)
    this.stone = this.add.image(cam.width * 0.62, midY, art.key).setScale(4).setOrigin(0.5, 1)

    // The arsenal at low opacity: §B3 asks for greyed out rather than absent,
    // and a dead rectangle labelled "Coming soon" reads as a rendering bug. Real
    // silhouettes read as content that is not ready yet.
    const y = cam.height * 0.76
    const spacing = 76
    const startX = cam.width / 2 - ((this.slots.length - 1) * spacing) / 2
    this.slots.forEach((slot, i) => {
      const a = weaponArt(slot.weaponKey)
      const x = startX + i * spacing
      const obj = a
        ? this.add.image(x, y, a.key).setScale(2)
        : this.add.rectangle(x, y, 40, 14, 0x2a2f36)
      obj.setAlpha(0.28)
      this.weaponRow.push(obj)
      this.weaponRow.push(
        this.add
          .text(x, y + 22, slot.label, { fontSize: '10px', color: '#6b737d' })
          .setOrigin(0.5, 0)
          .setAlpha(0.6),
      )
    })
  }

  private rebuildCharacter(x: number, y: number): void {
    this.preview?.container.destroy()
    const view = new PlayerView(this, this.choice.skinId)
    view.container.setPosition(x, y)
    view.container.setScale(3)
    this.preview = view
  }

  override update(_time: number, delta: number): void {
    this.t += delta / 1000
    const c = C()
    // Walking, not idle (§B3): a still frame hides skins that differ only by
    // palette, which is exactly how Kenney's pack is organised and therefore
    // exactly what this screen exists to show.
    this.preview?.setState(0, -c.PLAYER_H / 2, PREVIEW_VX, 0, 0, {
      alive: true,
      grounded: true,
      jetpack: false,
      shield: false,
      iframes: false,
    })
    // `setState` positions the container in world space; the preview is not in
    // the world, so put it back where the layout wants it.
    const cam = this.cameras.main
    this.preview?.container.setPosition(cam.width * 0.34, cam.height * 0.46)
  }

  private step(field: 'skinId' | 'tombstoneSkinId', delta: number): void {
    const count = field === 'skinId' ? this.skinCount : TOMBSTONE_ART.length
    this.choice = { ...this.choice, [field]: cycle(this.choice[field], delta, count) }
    saveChoice(localStorage, this.choice)
    if (field === 'skinId') {
      this.rebuildCharacter(this.cameras.main.width * 0.34, this.cameras.main.height * 0.46)
    } else {
      this.stone?.setTexture(tombstoneArt(this.choice.tombstoneSkinId).key)
    }
    this.render()
  }

  private back(): void {
    saveChoice(localStorage, this.choice)
    this.scene.start('Menu')
  }

  private buildDom(): void {
    const el = document.createElement('div')
    el.className = 'menu-screen skins-screen'
    document.body.appendChild(el)
    this.root = el
  }

  private skinName(): string {
    return skins()?.players.find((p) => p.id === this.choice.skinId)?.name ?? `Skin ${this.choice.skinId}`
  }

  private render(): void {
    const el = this.root
    if (!el) return
    el.innerHTML = `
      <h2>Skins</h2>
      <label class="field">Name
        <input id="name" maxlength="16" autocomplete="off" spellcheck="false"
               value="${this.choice.name}" aria-label="Player name">
      </label>
      <div class="picker" id="pick-skin">
        <button data-d="-1" aria-label="Previous character">◀</button>
        <span class="pick-label">Character<b id="skin-name">${this.skinName()}</b></span>
        <button data-d="1" aria-label="Next character">▶</button>
      </div>
      <div class="picker" id="pick-stone">
        <button data-d="-1" aria-label="Previous tombstone">◀</button>
        <span class="pick-label">Tombstone<b id="stone-name">${tombstoneArt(this.choice.tombstoneSkinId).name}</b></span>
        <button data-d="1" aria-label="Next tombstone">▶</button>
      </div>
      <fieldset class="coming-soon" disabled aria-label="Weapon skins, coming soon">
        <legend>Weapon skins</legend>
        <p>Coming soon</p>
      </fieldset>
      <div class="actions"><button id="back">Back</button></div>`

    const name = el.querySelector<HTMLInputElement>('#name')
    name?.addEventListener('input', () => {
      this.choice = { ...this.choice, name: name.value }
      saveChoice(localStorage, this.choice)
    })
    for (const [id, field] of [
      ['#pick-skin', 'skinId'],
      ['#pick-stone', 'tombstoneSkinId'],
    ] as const) {
      for (const b of el.querySelectorAll<HTMLButtonElement>(`${id} button`)) {
        b.addEventListener('click', () => this.step(field, Number(b.dataset.d)))
      }
    }
    el.querySelector('#back')?.addEventListener('click', () => this.back())
  }

  private exposeDebugHandle(): void {
    const self = this
    ;(window as unknown as { __skins: unknown }).__skins = {
      debug: () => ({
        ...self.choice,
        skinCount: self.skinCount,
        stoneCount: TOMBSTONE_ART.length,
        skinName: self.skinName(),
        stoneName: tombstoneArt(self.choice.tombstoneSkinId).name,
        /** Drawn, not intended (§A15): what the canvas actually holds. */
        weaponsShown: self.weaponRow.length,
        previewIsAtlas: self.preview?.usesAtlas ?? false,
        /** §B3 wants the walk cycle; a still frame is the failure it names. */
        previewFrame: self.preview?.currentFrame ?? '',
        /** The section must be present *and* inert, so report both. */
        weaponsDisabled: !!self.root?.querySelector('fieldset.coming-soon[disabled]'),
        stored: {
          skin: localStorage.getItem('deepcut.skin'),
          stone: localStorage.getItem('deepcut.stone'),
          name: localStorage.getItem('deepcut.name'),
        },
      }),
      step: (field: 'skinId' | 'tombstoneSkinId', d: number) => self.step(field, d),
    }
  }
}
