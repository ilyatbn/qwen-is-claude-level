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
}
