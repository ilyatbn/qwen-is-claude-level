/**
 * T23.01 step 3: the look-lab — `?look=F1` … `?look=F5`, a dev surface like `?sandbox=1`.
 *
 * Builds the scene description of a reference scene (`scenes/F*.ts`, the mockup's own data)
 * and hands it to the world renderer (`worldRenderer.ts::createWorldRenderer`, the constructor
 * the game scenes use), with Phaser's camera set to the scene's camera rect so the renderer is
 * driven exactly as the game drives it. Phaser draws nothing here: what is on screen is the
 * renderer's (`?world=off` swaps in the draw-nothing stub — the checks' control).
 *
 * `window.__look.ready` flips after the renderer has drawn a frame of the scene. An unknown id
 * is reported by name in `__look.error` and never becomes ready — the look-lab check's control.
 *
 * T23.04: `&only=sky` describes the scene's sky alone — no mask, actors, fx or labels — so
 * `look-sky` can compare the sky layer with the mockup's sky rendered alone
 * (`reference/controls/F1-sky.png`). Hidden in the data, not in the renderer: what is left is
 * exactly what the renderer draws of the full scene's sky.
 */
import Phaser from 'phaser'
import { devSurface } from '../dev'
import { actorBoxes, describeScene, type Box, type SceneDescription } from './scene'
import { SCENES } from './scenes'
import { loadWorldRenderer } from './loadWorldRenderer'
import { sceneCounts, type RenderStats, type SceneRenderer } from './renderer'

export interface LookHandle {
  ready: boolean
  id: string
  /** Every scene the lab can show, for a check to walk. */
  available: string[]
  error: string | null
  backend: SceneRenderer['backend'] | null
  /** Frames the renderer has drawn of this scene. */
  frames: number
  /** What the page built, counted — against `rendered`, what the renderer received. */
  described: RenderStats['scene']
  rendered: RenderStats['scene']
  camera: SceneDescription['camera'] | null
  /** T23.02: the actors' screen boxes from the description — look-compare's `actors` region. */
  actorBoxes: Box[]
  /** The view the renderer was last asked to draw: Phaser's `worldView`. */
  view: RenderStats['view']
}

export class LookScene extends Phaser.Scene {
  constructor() {
    super({ key: 'Look' })
  }

  create(): void {
    const id = new URLSearchParams(location.search).get('look') ?? ''
    const handle: LookHandle = {
      ready: false,
      id,
      available: Object.keys(SCENES),
      error: null,
      backend: null,
      frames: 0,
      described: null,
      rendered: null,
      camera: null,
      actorBoxes: [],
      view: null,
    }
    if (devSurface()) (window as unknown as { __look: LookHandle }).__look = handle

    const data = SCENES[id]
    if (!data) {
      handle.error = `unknown look scene "${id}" — have ${Object.keys(SCENES).join(', ')}`
      console.error(handle.error)
      return
    }
    const full = describeScene(data)
    const desc =
      new URLSearchParams(location.search).get('only') === 'sky'
        ? { ...full, masks: null, actors: [], fx: [], labels: [], hud: null }
        : full
    handle.camera = desc.camera
    handle.described = sceneCounts(desc)
    handle.actorBoxes = actorBoxes(desc)

    // The mockup draws at zoom 1 on a 1280×720 strip; fit the scene's camera rect to the
    // viewport so `worldView` is exactly that rect.
    const cam = this.cameras.main
    cam.setZoom(this.scale.width / desc.camera.w)
    cam.centerOn(desc.camera.x + desc.camera.w / 2, desc.camera.y + desc.camera.h / 2)

    // T23.03: the game's world renderer, through the same constructor the game scenes use —
    // loaded on demand like theirs (T23.03B, F10), so the lab measures the same path.
    void loadWorldRenderer(this).then((m) => {
      if (!m) return
      const renderer = m.createWorldRenderer(this, desc)
      const stats = (renderer as { stats?: RenderStats }).stats
      handle.backend = renderer.backend
      handle.rendered = stats?.scene ?? null
      // After the renderer's own `render` listener (registered first, so it runs first).
      this.events.on('render', () => {
        handle.frames = stats?.frames ?? 0
        handle.view = stats?.view ?? null
        handle.ready = handle.frames > 0
      })
    })
  }
}
