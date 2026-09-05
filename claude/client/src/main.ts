import Phaser from 'phaser'
import { GameScene } from './scenes/GameScene'
import { TitleScene } from './scenes/TitleScene'
import { MenuScene } from './scenes/MenuScene'
import { SkinsScene } from './scenes/SkinsScene'
import { C, Core } from './core'
import { devSurface } from './dev'

// No constants are declared here. VIEWPORT_W/H used to be literals in this file —
// a second source of truth for numbers that live in game-core/src/constants.rs.
// They now cross the WASM boundary with everything else. See docs/01-architecture.md.

/**
 * Who starts whom, for the four scenes a player can reach.
 *
 * **This table exists because a missing key is silent** (T20.13).
 * `ScenePlugin.start` queues a `stop` of the current scene and a `start` of the
 * key; if the key was never added, the stop still happens and the start does
 * nothing — leaving **no running scene at all**, which is a blank page. There is
 * no warning and no exception.
 *
 * `?menu=1` shipped `[Menu, Skins, Game]`, so `GameScene`'s "Exit to title" blanked
 * the page, and a T20.13 repro built on that flag reproduced an "empty screen" a
 * player never sees. `?game=1` shipped `[Game]` alone and has **two**
 * `scene.start('Title')` callers. Rather than patch each list, `closeOverStarts`
 * below makes the invariant structural: a dev list that can reach a scene
 * registers it.
 *
 * `scene-graph.test.ts` fails if a `scene.start('X')` appears in `src/scenes/`
 * that this table does not carry — so the table cannot fall behind the code.
 */
const SCENE_GRAPH: ReadonlyArray<{
  key: string
  ctor: Phaser.Types.Scenes.SceneType
  starts: readonly string[]
}> = [
  { key: 'Title', ctor: TitleScene, starts: ['Menu'] },
  { key: 'Menu', ctor: MenuScene, starts: ['Game', 'Skins'] },
  { key: 'Skins', ctor: SkinsScene, starts: ['Menu'] },
  { key: 'Game', ctor: GameScene, starts: ['Title'] },
]

/**
 * Append every scene the given list can reach through `scene.start`.
 *
 * Order is preserved and additions go on the end, because **Phaser starts the
 * first scene in the array and only adds the rest** — so the flag still lands
 * where it says it lands.
 *
 * Exported for its test; `main` is the only production caller.
 */
export function closeOverStarts(
  list: Phaser.Types.Scenes.SceneType[],
): Phaser.Types.Scenes.SceneType[] {
  const out = [...list]
  const keysOf = (l: Phaser.Types.Scenes.SceneType[]) =>
    SCENE_GRAPH.filter((n) => l.includes(n.ctor)).map((n) => n.key)
  // A worklist rather than one pass: Game reaches Title, Title reaches Menu, and
  // Menu reaches Skins. A single pass would register Title and stop.
  const queue = [...keysOf(out)]
  const seen = new Set(queue)
  while (queue.length) {
    const key = queue.shift() as string
    const node = SCENE_GRAPH.find((n) => n.key === key)
    if (!node) continue
    for (const next of node.starts) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
      const target = SCENE_GRAPH.find((n) => n.key === next)
      if (target && !out.includes(target.ctor)) out.push(target.ctor)
    }
  }
  return out
}

/**
 * The scenes a **player** can reach: the title first (§B3), with the rest
 * registered so `scene.start('Menu')` resolves.
 *
 * The dev scenes and every scene-selection query parameter live in
 * `pickDevScene` below, behind §C17's build flag, and are not in this list.
 */
function playerScenes(): Phaser.Types.Scenes.SceneType[] {
  // Spelled in full rather than derived from `TitleScene` alone: this is the
  // shipped path, and it should not depend on the graph table being right. The
  // closure is a no-op over it — and stays one only while the table is complete,
  // which is the point of asserting it in `scene-graph.test.ts`.
  return closeOverStarts([TitleScene, MenuScene, SkinsScene, GameScene])
}

/**
 * §C17: the dev scenes and the query parameters that reach them, **compiled out
 * of a production build**.
 *
 * The measured problem was that anyone could type `?sandbox=1` and get a
 * different game: the shipped bundle contained `__game`, `sandbox`,
 * `toggleOverlays` and `regenerate`, and `import.meta.env` appeared nowhere in
 * the source — nothing was gated at build time at all.
 *
 * The imports are **dynamic and inside the branch**. A top-level import of
 * `SandboxScene` would keep the module in the graph whatever the branch did;
 * inside a `if (false)` body the whole call disappears and the module is never
 * part of the build.
 */
async function pickDevScene(): Promise<Phaser.Types.Scenes.SceneType[] | null> {
  if (!devSurface()) return null
  const q = new URLSearchParams(location.search)

  if (q.get('sandbox') === '1') {
    return [(await import('./scenes/SandboxScene')).SandboxScene]
  }
  if (q.get('preview') === '1') {
    return [(await import('./scenes/PreviewScene')).PreviewScene]
  }
  if (q.get('boot') === '1') {
    return [(await import('./scenes/BootScene')).BootScene]
  }
  // `?game=1` drops straight into a round, which is what the e2e suite and the
  // two-client checks want — they were written before there was a front end and
  // should not have to click through it.
  if (q.get('game') === '1') return closeOverStarts([GameScene])
  // `?menu=1` starts at the menu rather than the title, so a check can arrive
  // *through* the Skins button — the button was a caller with no callee (§A39)
  // and a check that opened the picker by URL would have passed anyway.
  if (q.get('menu') === '1') return closeOverStarts([MenuScene])
  // `?skins=1` opens the picker directly, for the same reason `?game=1` exists.
  if (q.get('skins') === '1') return closeOverStarts([SkinsScene])
  return null
}

async function main(): Promise<Phaser.Game> {
  const core = await Core.init()
  const c = C()

  const scene = (await pickDevScene()) ?? playerScenes()

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: c.VIEWPORT_W,
    height: c.VIEWPORT_H,
    backgroundColor: '#0b1020',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      pixelArt: true,
      antialias: false,
    },
    scene,
  })

  // Right-click is the inventory toggle (docs/30-items-inventory.md §3), so the
  // browser context menu has to go.
  const suppress = (e: Event) => e.preventDefault()
  game.canvas?.addEventListener('contextmenu', suppress)
  document.getElementById('game')?.addEventListener('contextmenu', suppress)

  // The scenes need the core; Phaser's registry is the least surprising channel.
  game.registry.set('core', core)
  return game
}

export default main()
