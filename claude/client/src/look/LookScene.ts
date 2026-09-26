/**
 * T23.01 step 3: the look-lab — `?look=F1` … `?look=F5`, a dev surface like `?sandbox=1`.
 *
 * Builds the scene description of a reference scene (`scenes/F*.ts`, the mockup's own data)
 * and hands it to the world renderer, with Phaser's camera set to the scene's camera rect so
 * the renderer is driven exactly as the game drives it (`renderer.ts::driveFromScene`). Phaser
 * draws nothing here: whatever is on screen is the renderer's.
 *
 * `window.__look.ready` flips after the renderer has drawn a frame of the scene. An unknown id
 * is reported by name in `__look.error` and never becomes ready — the look-lab check's control.
 */
import Phaser from 'phaser'
import { devSurface } from '../dev'
import { describeScene, type SceneDescription } from './scene'
import { SCENES } from './scenes'
import { StubRenderer, driveFromScene, sceneCounts, type RenderStats, type SceneRenderer } from './renderer'

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
      view: null,
    }
    if (devSurface()) (window as unknown as { __look: LookHandle }).__look = handle

    const data = SCENES[id]
    if (!data) {
      handle.error = `unknown look scene "${id}" — have ${Object.keys(SCENES).join(', ')}`
      console.error(handle.error)
      return
    }
    const desc = describeScene(data)
    handle.camera = desc.camera
    handle.described = sceneCounts(desc)

    // The mockup draws at zoom 1 on a 1280×720 strip; fit the scene's camera rect to the
    // viewport so `worldView` is exactly that rect.
    const cam = this.cameras.main
    cam.setZoom(this.scale.width / desc.camera.w)
    cam.centerOn(desc.camera.x + desc.camera.w / 2, desc.camera.y + desc.camera.h / 2)

    const renderer = new StubRenderer()
    handle.backend = renderer.backend
    renderer.setScene(desc)
    handle.rendered = renderer.stats.scene
    driveFromScene(this, renderer, () => {
      handle.frames = renderer.stats.frames
      handle.view = renderer.stats.view
      handle.ready = true
    })
    this.events.once('shutdown', () => renderer.destroy())
  }
}
