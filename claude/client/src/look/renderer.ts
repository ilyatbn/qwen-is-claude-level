/**
 * T23.01 (R1, R11): the world renderer's interface, and how a Phaser scene drives it.
 *
 * A renderer takes plain data (`SceneDescription`) and a view rect, and draws. It never reads
 * the sim and never owns a camera: **Phaser's camera is the only source of truth** (R1), and
 * `driveFromScene` copies its `worldView` into the renderer once per drawn frame.
 *
 * ## Why the frame is driven from the scene's `RENDER` event
 *
 * `camera.worldView` is recomputed in `Camera.preRender`, which `CameraManager.render` calls
 * **after** the scene's `update` and after the scene's own `PRE_RENDER` event. A layer laid out
 * from `worldView` in `update` is drawn against last frame's camera — the `living-sky` trap,
 * measured at 3–9 px of trail on a falling camera (`render/parallax-math.ts::liveViewY`).
 * `Systems.render` emits `RENDER` right after `cameras.render`, i.e. after `preRender` has
 * run for this frame, in the same task as Phaser's own draw — so both canvases present the
 * same frame. (Phaser 3.90 `scene/Systems.js::render`.)
 */
import type Phaser from 'phaser'
import type { SceneDescription, ViewRect } from './scene'

export type RendererBackend = 'stub' | 'three'

export interface SceneRenderer {
  readonly backend: RendererBackend
  /** Hand over the scene. Plain data; the renderer may keep the reference. */
  setScene(desc: SceneDescription): void
  /** Draw one frame of the current scene as seen through `view` (mask px, y down). */
  render(view: ViewRect): void
  destroy(): void
}

/** What a renderer has seen — both ends of the hand-over, for the checks to count. */
export interface RenderStats {
  frames: number
  view: ViewRect | null
  /** Counts of what `setScene` received, `null` before it was called. */
  scene: { id: string; actors: number; lights: number; fx: number; labels: number; solidPx: number | null } | null
}

export function sceneCounts(d: SceneDescription): NonNullable<RenderStats['scene']> {
  return {
    id: d.id,
    actors: d.actors.length,
    lights: d.look.lights.length,
    fx: d.fx.length,
    labels: d.labels.length,
    solidPx: d.masks ? d.masks.solid.reduce((a, b) => a + b, 0) : null,
  }
}

/** Draws nothing; records what it was given. The look-lab's renderer until T23.03. */
export class StubRenderer implements SceneRenderer {
  readonly backend = 'stub' as const
  readonly stats: RenderStats = { frames: 0, view: null, scene: null }

  setScene(desc: SceneDescription): void {
    this.stats.scene = sceneCounts(desc)
  }

  render(view: ViewRect): void {
    this.stats.frames++
    this.stats.view = { ...view }
  }

  destroy(): void {}
}

/** The view rect of a Phaser camera's `worldView`, as the renderer takes it. */
export function viewOf(cam: Pick<Phaser.Cameras.Scene2D.Camera, 'worldView'>): ViewRect {
  const v = cam.worldView
  return { x: v.x, y: v.y, w: v.width, h: v.height }
}

/**
 * Render `r` once per drawn frame of `scene`, from its main camera, after the camera's
 * `preRender` (see the module comment). Detaches itself on shutdown; returns the detach.
 * `onFrame` runs after each render — the look-lab uses it to say a frame is done.
 */
export function driveFromScene(scene: Phaser.Scene, r: SceneRenderer, onFrame?: () => void): () => void {
  const draw = (): void => {
    r.render(viewOf(scene.cameras.main))
    onFrame?.()
  }
  // String keys: `Phaser.Scenes.Events.RENDER === 'render'`, `SHUTDOWN === 'shutdown'`. The
  // import is type-only so this module stays loadable in vitest without a DOM.
  scene.events.on('render', draw)
  const detach = (): void => {
    scene.events.off('render', draw)
  }
  scene.events.once('shutdown', detach)
  return detach
}
