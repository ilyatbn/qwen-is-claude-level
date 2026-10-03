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
 * T23.07: every scene whose mask the fields can take (`labFields.ts`: whole chunks wide — F1, F2, F5;
 * T23.20: F3 too, its padding mirrored) draws its **lit terrain** from those fields, with the scene's own lights; `ready`
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
 *
 * T23.18: the scene's effects (`fx`: ribbons, soft sprites, the explosion) are drawn — the lab is the whole picture;
 * `&knob=fx-off` leaves them out, for the references that were rendered without them (the cast-only controls).
 */
import Phaser from 'phaser'
import { devSurface } from '../dev'
import { actorBoxes, describeScene, type Box, type FrameLook, type SceneDescription } from './scene'
import { SCENES } from './scenes'
import { WORLD_LOOK_IDS, WORLD_LOOKS, type WorldLookId } from './worlds'

/** T23.31: the reference scene a world look is shown on in the lab — its night picture's. */
const WORLD_SCENE: Record<WorldLookId, string> = { classic: 'F1', volcanic: 'F2' }
import { loadWorldRenderer } from './loadWorldRenderer'
import { sceneCounts, type RenderStats, type SceneRenderer } from './renderer'
import { C, Core } from '../core'
import { LabFields } from './labFields'
import { albedoTheme } from './albedo'
import { fxFeed } from './fx/feed'
import { BLAST_PEAK, BLAST_REACH, MOCKUP_STREAM } from './fx/game'
import { OrdnanceState } from '../render/ordnance-state'
import { mountLabHud } from '../ui/labHud'

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
  /** T23.19D F6 (`&knob=game-blast`): the staged game blast — its age share and the blasts in its state. */
  gameBlast?: { k: number; blasts: number }
  /** T23.21B: whether the game's HUD is mounted over the scene (its `hud`, the picture's `hudE`) — and its faces loaded. */
  hud?: boolean
}

/** T23.19D F6: the staged game blast's default age, as a share of its life — its peak (R27). */
export const GAME_BLAST_K = BLAST_PEAK

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

    const q = new URLSearchParams(location.search)
    // T23.11: `&t=` (0–1) draws the scene at that hour of the game's blend — F5's moonlit day at 0, F1's night at 1
    // (`daylight.ts`), the moons at the pictures' places. Only for the combat pair (F1/F5: "only the palette differs");
    // the cast and effects are the nearer end's scene (shapes never blend).
    // T23.31: `?look=classic` / `?look=volcanic` — a world look (`worlds.ts`) on its night picture's scene (F1, F2), its
    // own two ends for `&t=`, and the volcanic one's backdrop. `?look=F2` stays the mockup's picture verbatim (Level A).
    const world = (WORLD_LOOK_IDS as readonly string[]).includes(id) ? WORLD_LOOKS[id as WorldLookId] : null
    const tArg = q.get('t')
    const tLab = tArg === null ? null : Number(tArg)
    if (tLab !== null && (!(tLab >= 0 && tLab <= 1) || (id !== 'F1' && id !== 'F5' && !world))) {
      handle.error = `&t=${tArg}: a number in 0..1, on F1, F5 or a world look only`
      console.error(handle.error)
      return
    }
    const sceneId = world ? WORLD_SCENE[world.id] : id
    const data = tLab === null || world ? SCENES[sceneId] : tLab >= 0.5 ? SCENES['F1'] : SCENES['F5']
    if (!data) {
      handle.error = `unknown look scene "${id}" — have ${Object.keys(SCENES).join(', ')}`
      console.error(handle.error)
      return
    }
    const full = describeScene(data)
    const only = q.get('only')
    // T23.18: every `knob` parameter, joined — a check adds `&knob=fx-off` to a URL that already names a knob.
    const knobs = q.getAll('knob').join(',')
    let actorRim = true
    let jetOff = false
    let fxOff = false
    let gameBlast = false
    let albedoDusk = false
    // T23.11: the knobs and `only=` applied to a look — the scene's, or each end of the `&t=` blend.
    const lookOf = (src: FrameLook): FrameLook => {
      const terrainLook = { ...src.terrain }
      let look: FrameLook = { ...src, terrain: terrainLook }
      const P = src
      // T23.13: knobs combine, comma-separated (`actor-rim-off,exposure-up`: a control of T23.12's picture).
      for (const knob of (knobs ?? '').split(',').filter(Boolean)) {
        if (knob === 'rim-off') terrainLook.rimK = 0
        else if (knob === 'bevel-off') terrainLook.bevel = 0.001
        // T23.31: the volcanic seams out — look-volcanic's must-fail control for the lava term.
        else if (knob === 'lava-off') terrainLook.lavaK = 0
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
        // T23.13: the actors without lit()'s two rim passes (castonly.js 'rim-off') — rim-light's must-fail control.
        else if (knob === 'actor-rim-off') actorRim = false
        // T23.14B: every jet flame out (a figure's `J.jet`, a stick's `jet`) — `jet-flame`'s must-fail control.
        else if (knob === 'actor-jet-off') jetOff = true
        // T23.18: the scene without its effects (`fx`) — what `castonly.js`/`posesonly.js`/`weaponsonly.js` render, and
        // `look-fx`'s must-fail control.
        else if (knob === 'fx-off') fxOff = true
        // T23.19D F6: the scene's explosion drawn **the game's way** — a `Blast` record in an ordnance layer's state, built
        // by `fx/game.ts::blastFx` from the scene's fx feed (`gameFrame`), as a match draws one, with the mockup's stream —
        // instead of the scene's still (`sceneFx`). `&blastk=` is its age as a share of its life (default: the peak, R27).
        else if (knob === 'game-blast') gameBlast = true
        // T23.20: F3's rock painted with the ground's palette — look-gate-f3's control that the asteroid's is drawn.
        else if (knob === 'albedo-dusk') albedoDusk = true
        else handle.error = `unknown knob "${knob}"`
      }
      // T23.04–T23.07's references were rendered without fog, foreground, bloom or grade (`skyonly.js`, `terrainonly.js`).
      const bare = { fogBack: null, fogFront: null, fg: null, bloom: [0, P.bloom[1], P.bloom[2]] as FrameLook['bloom'], grade: null }
      return only === 'sky' ? { ...src, ...bare } : only === 'terrain' ? { ...look, ...bare } : look
    }
    const look = lookOf(full.look)
    const cast = { actors: [], fx: [], labels: [], hud: null }
    const desc: SceneDescription =
      only === 'sky'
        ? { ...full, look, masks: null, litTerrain: false, ...cast }
        : only === 'terrain' || only === 'world'
          ? { ...full, look, ...cast }
          : { ...full, look }
    if (tLab !== null && world) {
      desc.daylight = { day: lookOf(world.day.look), night: lookOf(world.night.look), dayPalette: world.day.palette, nightPalette: world.night.palette }
    } else if (tLab !== null) {
      const [f5, f1] = [SCENES['F5']!, SCENES['F1']!]
      desc.daylight = { day: lookOf(f5.look), night: lookOf(f1.look), dayPalette: f5.palette, nightPalette: f1.palette }
    }
    if (world?.backdrop && only !== 'terrain' && only !== 'albedo') desc.backdrop = { kind: world.backdrop, seed: Number(q.get('seed') ?? 0) }
    desc.actorRim = actorRim
    if (albedoDusk) desc.albedo = 'dusk'
    if (fxOff) desc.fx = []
    const staged = gameBlast ? desc.fx.find((f) => f.kind === 'explosion') : undefined
    if (gameBlast) {
      if (!staged) handle.error = 'game-blast: this scene has no explosion'
      desc.fx = desc.fx.filter((f) => f.kind !== 'explosion')
    }
    if (jetOff) {
      desc.actors = desc.actors.map((a) =>
        a.kind === 'figure' && a.opts.J ? { ...a, opts: { ...a.opts, J: { ...a.opts.J, jet: 0 } } } : a.kind === 'stick' ? { ...a, opts: { ...a.opts, jet: false } } : a,
      )
    }
    // T23.21B: the scene's HUD (`hudE` in the mockup) is the game's own (`ui/labHud.ts`), over the full scene; `only=hud`
    // draws it alone on black and no world — `look-hud`'s side of Level A, against `hudE` itself on black.
    const hudData = only === null || only === 'hud' ? full.hud : null
    if (hudData) {
      void Core.init().then(async () => {
        const mounted = mountLabHud(document, hudData)
        this.events.once('shutdown', () => mounted.destroy())
        await document.fonts.ready
        handle.hud = true
        if (only === 'hud') handle.ready = true
      })
    }
    if (only === 'hud') {
      if (!hudData) handle.error = `only=hud: scene "${id}" has no hud`
      document.body.style.background = '#000'
      this.game.canvas.style.visibility = 'hidden'
      return
    }
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
      // T23.11: the smoke's colours are the hour's (`fx/game.ts::smokeLook`) — F5's scene is the moonlit day, the rest night.
      fxFeed(this).night = tLab ?? (id === 'F5' ? 0 : 1)
      const renderer = m.createWorldRenderer(this, desc)
      if (tLab !== null && renderer instanceof m.WorldRenderer) renderer.setDaylight(tLab, null)
      if (staged?.kind === 'explosion' && renderer instanceof m.WorldRenderer) {
        // One blast, at the scene's explosion, sized so `blastScale(r)` is its `scale`, at `blastk` of its life.
        const k = Number(q.get('blastk') ?? GAME_BLAST_K)
        const life = C().BLAST_SHADER_LIFE
        const state = new OrdnanceState(0, life)
        // The mockup's own stream (R27): at the peak age this is F1's explosion, drawn the game's way.
        state.blasts.push({ x: staged.x, y: staged.y, r: staged.scale * BLAST_REACH, age: k * life, ttl: life, stream: MOCKUP_STREAM })
        const feed = fxFeed(this)
        feed.ordnance = { state, visible: true, flameRadius: 0, bulletLength: 0 }
        renderer.setFxFeed(feed)
        handle.gameBlast = { k, blasts: state.blasts.length }
      }
      const stats = (renderer as { stats?: RenderStats }).stats
      handle.backend = renderer.backend
      handle.rendered = stats?.scene ?? null
      let albedoDone = (): boolean => true
      if (core && desc.masks && renderer instanceof m.WorldRenderer) {
        let lab: LabFields | null = null
        try {
          // T23.31: the relief's boulders by the albedo the scene is painted with (`setScene`'s rule) — F2's volcanic.
          const albedo = desc.albedo ?? albedoTheme((desc.daylight?.nightPalette ?? desc.palette)?.theme)
          lab = new LabFields(core, desc.masks, desc.look.terrain.scorch ?? [], albedo === 'asteroid', albedo === 'volcanic')
        } catch (e) {
          // A strip the fields cannot take: no lit terrain (only=albedo: an error). T23.20: F3 mirrors its padding.
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
