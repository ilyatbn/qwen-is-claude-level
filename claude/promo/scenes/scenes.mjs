/**
 * The trailer's gameplay scenes (M99, T99.04): what each one's server runs, how its camera is
 * directed, what is staged during the take, and how the clip is cut and captioned.
 *
 * Owner rules: all bots carry every weapon, on 1000 health, on a small map — never the Random
 * shape (bots play it badly); full quality, no film grain.
 *
 * `FIXED_SEED` picks the map, and with it the look (`world_look_for`): 7 is classic, 8 volcanic.
 * `DEV_ROUND_CLOCK` starts the round at a chosen time of day — 76 s is full night (the cycle is
 * 120 s; night holds from 74.4 s to 108 s).
 */
import { focus, zoomTo } from './director.mjs'
import { sleep } from '../lib.mjs'

/** Every bot armed with everything, hunting, on 1000 health, cycling its weapons. */
const ARMED = {
  BOT_COUNT: '5',
  BOT_SKILL: '1',
  DEV_BOT_FRENZY: '1',
  DEV_BOT_ARSENAL: '1',
  DEV_START_KIT: 'all',
  DEV_START_HEALTH: '1000',
  MAP_SCALE: 'small',
  DEV_MAP_SHAPE: 'hill',
}

const debug = (page) => page.evaluate(() => window.__game.debug())

/** The server's own view of the round (`debug_effects`, `DEV_PROBE=1`): every player, where, alive. */
const server = (page) => page.evaluate(() => window.__game.probeRound())

/**
 * The bots' ids, from the server — the client only hears of players near its view, so its remotes are not a roster.
 * Every player is a bot: the director is a spectator, with no body.
 */
const botIds = async (page) => (await server(page)).players.map((p) => p.id).sort((a, b) => a - b)

/**
 * Put bots at `spots` (`[x, y]`, body centre, world px) and hold them there `anchor` seconds, still fighting
 * (`debug_place` with `id` and `anchor`, `DEV_PROBE=1`). Returns the ids placed.
 */
async function place(page, spots, anchor) {
  const ids = await botIds(page)
  for (const [k, [x, y]] of spots.entries()) {
    if (ids[k] === undefined) break
    await page.evaluate(([x, y, id, a]) => window.__game.debugPlace(x, y, id, a), [x, y, ids[k], anchor])
    await sleep(60)
  }
  await sleep(300)
  const got = (await server(page)).players.filter((p) => ids.includes(p.id))
  console.log('placed:', got.map((p) => `${p.id}@${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' '))
  return ids.slice(0, spots.length)
}

export const SCENES = {
  scene1: {
    env: { ...ARMED, FIXED_SEED: '7', DEV_ROUND_CLOCK: '73', WEATHER: 'off' },
    director: 'busy',
    zoom: 1.2,
    seconds: 30,
    // All five in one bowl (seed 7's ground between x 560 and 880, measured off the generated map), 60-120 px
    // apart: near enough for the flamethrower, far enough for a rocket — each in its own turn of the rotation.
    stage: async (page) => {
      await place(page, [[600, 772], [670, 800], [740, 765], [810, 748], [870, 712]], 4)
      return { focus: { x: 735, y: 780 } }
    },
    cues: [{ at: 6, what: 'free the camera', run: (page) => focus(page, null) }],
    caption: { text: 'TRUST NO ONE' },
    // Take 12, 4.5 s in: blasts, a burst of fire, then the lasers cross — every kind in five seconds.
    cut: { dur: 5, in: 4.5 },
  },
  scene3: {
    // Space (`DEV_GRAVITY=space`; the map is the asteroid field, seed 7's measured below). Two bots stand on the
    // **undersides** of the two big rocks (909,442 r99 and 603,480 r96), upside down, anchored and firing at the
    // three below and beside them. The black hole is summoned on the far rock (1753,731), out of the fight's reach;
    // at the cue a fourth bot is put just outside its horizon and the camera follows it in.
    env: { ...ARMED, FIXED_SEED: '7', DEV_GRAVITY: 'space', WEATHER: 'off' },
    director: 'busy',
    zoom: 1.3,
    seconds: 14,
    stage: async (page) => {
      const ids = await place(
        page,
        [[909, 555], [603, 590], [840, 688], [1132, 649], [1753, 640]],
        14,
      )
      // The hole eats the rock nearest the last bot (the far one), then that bot is left where it stands.
      await page.evaluate((id) => window.__game.debugBlackHole(undefined, false, id), ids[4])
      await sleep(500)
      const hole = (await debug(page)).blackHole.hole
      console.log('hole:', JSON.stringify(hole))
      return { focus: { x: 860, y: 600 }, hole, victim: ids[4] }
    },
    cues: [
      {
        at: 3.4,
        what: 'pan to the black hole',
        run: async (page) => {
          const hole = (await debug(page)).blackHole.hole
          await focus(page, { x: hole.x - 140, y: hole.y - 60 }, 0.06)
        },
      },
      {
        at: 4.8,
        what: 'a bot at the horizon',
        run: async (page) => {
          const hole = (await debug(page)).blackHole.hole
          const victim = (await server(page)).players.map((p) => p.id).sort((a, b) => a - b)[4]
          // Three horizons out, held (anchored: no jet to escape on), so the pull drags it in over a second or two.
          await page.evaluate(([x, y, id]) => window.__game.debugPlace(x, y, id, 6), [hole.x - 190, hole.y - 90, victim])
        },
      },
      {
        at: 10,
        what: 'is the victim gone?',
        run: async (page) => {
          const p = (await server(page)).players
          console.log('after the pull:', p.map((q) => `${q.id}${q.alive ? '' : '(dead)'}@${q.x.toFixed(0)},${q.y.toFixed(0)}`).join(' '))
        },
      },
    ],
    caption: { text: 'SURVIVE THE HARSHNESS OF SPACE' },
    // From the upside-down fight, the pan, to the bot dragged into the hole (~5–7 s into the take).
    cut: { dur: 7, in: 0.3 },
  },
  scene4: {
    // Islands (seed 9: three high islands with open air between, measured). The bots start on the facing edges of
    // the west and middle islands and one in the air between, so the fight is across the gap — on jetpacks. At the
    // cue one bot is put on the middle island's teleport pad (1104,238) and held there (anchored) while it charges;
    // the camera closes on it, it vanishes, and the clip fades to black (`cut.fadeOut`).
    env: { ...ARMED, FIXED_SEED: '9', DEV_MAP_SHAPE: 'islands', DEV_ROUND_CLOCK: '30', WEATHER: 'off' },
    director: 'busy',
    zoom: 1.2,
    seconds: 16,
    stage: async (page) => {
      await place(page, [[470, 225], [520, 255], [930, 260], [990, 225], [720, 170]], 2)
      return { focus: { x: 730, y: 260 } }
    },
    cues: [
      { at: 3, what: 'free the camera', run: (page) => focus(page, null) },
      {
        at: 4.2,
        what: 'close in on the pad',
        run: async (page) => {
          // The pad, not the bot: the camera must stay where it vanishes, not follow it to the far pad.
          await focus(page, { x: 1104, y: 222, lift: 10 }, 0.07)
          await zoomTo(page, 2, 1.8)
        },
      },
      {
        at: 5.6,
        what: 'a bot on the pad',
        run: async (page) => {
          const ids = (await server(page)).players.map((p) => p.id).sort((a, b) => a - b)
          const id = ids[3]
          await page.evaluate(([id]) => window.__game.debugPlace(1104, 222, id, 5), [id])
          const t0 = Date.now()
          // Watch the server for the jump (a pad moves you to another pad): the cut ends just after it.
          for (let i = 0; i < 40; i++) {
            await sleep(100)
            const me = (await server(page)).players.find((p) => p.id === id)
            if (me && Math.hypot(me.x - 1104, me.y - 222) > 200) {
              console.log(`teleported ${((Date.now() - t0) / 1000 + 5.6).toFixed(2)} s into the take`)
              break
            }
          }
        },
      },
    ],
    caption: { text: 'MILLIONS OF RANDOMIZED MAPS' },
    // Take 2: the bot stands in the gate and is gone at ~7.1 s (by the frames' own clock); the fade follows it.
    cut: { dur: 8, in: 0.6, fadeOut: [-0.75, -0.02] },
  },
  final: {
    // Every creature on one moonlit hillside: seed 7's bowl (x 560–880) from dusk into night, the classic beetle and spider
    // beside the volcanic tripod and crawler (`setFaunaMix`: alternate ids drawn as the other world's), birds flying
    // over both ways, re-launched as they leave, and the night's fireflies. No fight: the one bot a match needs is
    // parked far off and held (anchored). Recorded 30 s, played three times as fast.
    // From dusk (67 s: the moons up, the fireflies coming in) into full night — at 3x, the light falls as you watch.
    env: { ...ARMED, BOT_COUNT: '1', FIXED_SEED: '7', DEV_ROUND_CLOCK: '67', WEATHER: 'off' },
    director: 'busy',
    zoom: 1.3,
    seconds: 32,
    stage: async (page) => {
      await place(page, [[1950, 700]], 120)
      await page.evaluate(() => {
        const g = window.__game
        g.setFaunaMix(true)
        g.setItemsVisible(false)
        g.debugFauna(720, 5, 5, 4)
      })
      return { focus: { x: 720, y: 640, lift: 0 } }
    },
    cues: [5, 10, 15, 20, 25].map((at) => ({
      at,
      what: 'more birds',
      run: (page) => page.evaluate(() => window.__game.debugFauna(720, 0, 0, 3)),
    })),
    lines: [
      { text: 'SHRED', at: 1.0, char: 0.12, hold: 1.0, erase: 0.5, center: true },
      { text: 'COMING SOON', at: 3.6, char: 0.1, center: true },
    ],
    // Night is dark by design; the clip is lifted a little so the creatures read under the type.
    cut: { dur: 10, in: 0.5, speed: 3, fadeOut: [-0.8, -0.02], grade: 'brightness(1.3) contrast(1.05) saturate(1.1)' },
  },
  scene2: {
    // Seed 8 is volcanic. `WEATHER=meteor` keeps a shower falling (one every `METEOR_EVERY`), restarted the moment
    // one ends; the camera shakes on every impact near it (`shakeOrigin`, doubled for the shot).
    env: { ...ARMED, FIXED_SEED: '8', DEV_ROUND_CLOCK: '20', WEATHER: 'meteor' },
    director: 'busy',
    zoom: 1.2,
    seconds: 30,
    stage: async (page) => {
      await page.evaluate(() => window.__game.setShakeScale(2))
      // The flat between seed 8's two hills, x 480–800 (measured off the generated map).
      await place(page, [[500, 770], [570, 770], [640, 768], [720, 665], [790, 745]], 4)
      return { focus: { x: 650, y: 720 } }
    },
    cues: [{ at: 6, what: 'free the camera', run: (page) => focus(page, null) }],
    caption: { text: 'FIGHT THROUGH DISASTERS ON DIFFERENT BIOMES' },
    // Blasts (the meteors') carry it; fire on screen counts against a window (owner: fire is an accent).
    cut: { dur: 5, weight: { explosion: 5, flame: -1.5 } },
  },
}
