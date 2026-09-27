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
 *
 * T23.06: `&only=albedo` draws the scene's terrain albedo flat (`WorldRenderer.showAlbedo`) — its
 * masks through the Rust fields (`labFields.ts`) and the GPU albedo pass, with the scene's scorch
 * list as blasts — for `look-albedo` to compare with the mockup's own albedo
 * (`reference/controls/F1-albedo.png`). `ready` waits for every albedo tile.
 *
 * T23.07: every scene whose mask the fields can take (`labFields.ts`: whole chunks wide, solid bottom
 * row — F1, F2, F5) draws its **lit terrain** from those fields, with the scene's own lights; `ready`
 * waits for the terrain (and the low tier's bake). `&only=world` describes the sky and terrain alone —
 * actors, fx, labels and HUD out of the data — for `look-terrain` to compare with the mockup's sky and
 * terrain alone (`reference/controls/F1-terrain.png`). `&knob=rim-off|bevel-off|lights-off` changes
 * the terrain look in the data (the must-fail controls: `terrainonly.js`'s knobs).
 *
 * T23.08: `&only=world` is now the world without its cast — sky, back fog, lit terrain, front fog, the
 * foreground leaves, bloom and grade (`reference/controls/worldonly.js` → `F1-world.png`, look-gate-f1);
 * `&only=terrain` is T23.07's sky + terrain alone (look-terrain), and `&only=sky` keeps no fog or post
 * either — their references have none. Knobs `bloom-off | fog-off | exposure-up | exposure-down |
 * fg-off | grade-off` are the gate's controls (`worldonly.js`'s knobs, lab side).
 */
import Phaser from 'phaser'
import { devSurface } from '../dev'
import { actorBoxes, describeScene, type Box, type SceneDescription } from './scene'
import { SCENES } from './scenes'
import { loadWorldRenderer } from './loadWorldRenderer'
import { sceneCounts, type RenderStats, type SceneRenderer } from './renderer'
import { Core } from '../core'
import { LabFields } from './labFields'

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
  /** T23.06 (`only=albedo`): FNV-1a-32 of each field channel over the scene's rows — against T23.05's mockup dump. */
  fields: ReturnType<LabFields['channelFnv']> | null
  /** T23.07: whether the lit terrain is drawn, or why not (a mask the fields cannot take). */
  terrain: boolean | string
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
      fields: null,
      terrain: false,
    }
    if (devSurface()) (window as unknown as { __look: LookHandle }).__look = handle

    const data = SCENES[id]
    if (!data) {
      handle.error = `unknown look scene "${id}" — have ${Object.keys(SCENES).join(', ')}`
      console.error(handle.error)
      return
    }
    const full = describeScene(data)
    const q = new URLSearchParams(location.search)
    const only = q.get('only')
    const knob = q.get('knob')
    const terrainLook = { ...full.look.terrain }
    let look: SceneDescription['look'] = { ...full.look, terrain: terrainLook }
    const P = full.look
    if (knob === 'rim-off') terrainLook.rimK = 0
    else if (knob === 'bevel-off') terrainLook.bevel = 0.001
    else if (knob === 'lights-off') look.lights = []
    // T23.08: the gate's must-fail controls through the game's renderer (look-thresholds.json's controls, lab side).
    else if (knob === 'bloom-off') look.bloom = [0, P.bloom[1], P.bloom[2]]
    // T23.08C (R25): the halo's spread alone — `worldonly.js`'s 'bloom-radius-0'; the halo ring must see it.
    else if (knob === 'bloom-radius-0') look.bloom = [P.bloom[0], 0, P.bloom[2]]
    else if (knob === 'fog-off') look = { ...look, fogBack: null, fogFront: null }
    else if (knob === 'exposure-up') look.exposure = P.exposure * 1.1
    else if (knob === 'exposure-down') look.exposure = P.exposure * 0.9
    else if (knob === 'fg-off') look.fg = null
    else if (knob === 'grade-off') look.grade = null
    else if (knob !== null) handle.error = `unknown knob "${knob}"`
    // T23.04–T23.07's references were rendered without fog, foreground, bloom or grade (`skyonly.js`, `terrainonly.js`).
    const bare = { fogBack: null, fogFront: null, fg: null, bloom: [0, P.bloom[1], P.bloom[2]] as SceneDescription['look']['bloom'], grade: null }
    const cast = { actors: [], fx: [], labels: [], hud: null }
    const desc: SceneDescription =
      only === 'sky'
        ? { ...full, look: { ...full.look, ...bare }, masks: null, litTerrain: false, ...cast }
        : only === 'terrain'
          ? { ...full, look: { ...look, ...bare }, ...cast }
          : only === 'world'
            ? { ...full, look, ...cast }
            : { ...full, look }
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
    void Promise.all([loadWorldRenderer(this), desc.masks ? Core.init() : null]).then(([m, core]) => {
      if (!m) return
      const renderer = m.createWorldRenderer(this, desc)
      const stats = (renderer as { stats?: RenderStats }).stats
      handle.backend = renderer.backend
      handle.rendered = stats?.scene ?? null
      let albedoDone = (): boolean => true
      if (core && desc.masks && renderer instanceof m.WorldRenderer) {
        let lab: LabFields | null = null
        try {
          lab = new LabFields(core, desc.masks, desc.look.terrain.scorch ?? [])
        } catch (e) {
          // F3 (space): no solid bottom row to pad — no lit terrain (only=albedo: an error). F4 pads (T23.12 draws its cast on it).
          if (only === 'albedo') {
            handle.error = String(e)
            return
          }
          handle.terrain = String(e)
          renderer.setScene({ ...desc, litTerrain: false })
        }
        if (lab) {
          handle.fields = lab.channelFnv(desc.masks.h)
          renderer.setTerrain(lab, Infinity)
          if (only === 'albedo') renderer.showAlbedo(true)
          handle.terrain = only !== 'albedo'
          albedoDone = () => renderer.terrain.ready && renderer.terrain.pending === 0
        }
      }
      // After the renderer's own `render` listener (registered first, so it runs first).
      this.events.on('render', () => {
        handle.frames = stats?.frames ?? 0
        handle.view = stats?.view ?? null
        handle.ready = handle.frames > 0 && albedoDone()
      })
    })
  }
}
