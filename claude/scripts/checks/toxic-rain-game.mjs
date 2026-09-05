#!/usr/bin/env node
/**
 * Toxic rain in the scene a player is actually in (T20.05).
 *
 *   node scripts/checks/toxic-rain-game.mjs
 *
 * ## Why this exists
 *
 * Every weather assertion in this tree ran against `?sandbox=1` —
 * `weather-visible.mjs` and `m5-weather.mjs` both `regenerate(...)` a local world
 * and drive the layers by hand. **That is the §C0 shape this project has paid for
 * repeatedly**: `SandboxScene` calls `this.world.update(...)` with no `dt`, so
 * `WorldView`'s shared weather block never runs there, and the scene pokes
 * `weather.setToxic(...)` itself. A rain wired only through the shared block is a
 * rain the gating checks cannot see, and a rain wired only in the sandbox is a
 * rain nobody plays. `ordnance.update` shipped broken in exactly this way for
 * three milestones while the sandbox check stayed green.
 *
 * T20.05 rewired the emitter's density to the **live projectile count**, which in
 * a real round means: the server spawns `toxic_drop` projectiles, broadcasts
 * `projectile_spawn`, the client's mirror holds them, `syncProjectiles` puts them
 * in the ordnance layer, `WEAPON_KEYS[23]` resolves to `toxic_drop`, and
 * `KIND_BY_WEAPON_KEY` maps that to `drop`. **Six hops, none of them previously
 * asserted end to end**, and every one of them silently yields a count of zero —
 * which under the new derivation is a dry sky rather than an error.
 *
 * `WEATHER=toxic` is the switch that makes it testable, the same `Config` family
 * `fog-visible` uses: without it this waits out `EFFECT_INTERVAL_MIN` and then
 * hopes the scheduler rolled rain rather than fog, a one-in-four coin flip inside
 * a gate.
 */
import { startStack, enterBattle, tally, sleep } from './harness.mjs'

const PORT = 3136
const { fail, ok, finish } = tally('toxic-rain-game')

const stack = await startStack({
  port: PORT,
  label: 'toxic-rain-game',
  env: {
    WEATHER: 'toxic',
    BOT_COUNT: '0',
    LOBBY_BOT_TIMEOUT: '3',
  },
})

const { page, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'toxic-rain-game' })

const read = () =>
  page.evaluate(() => {
    const g = window.__game
    const d = g.debug()
    return {
      real: d.toxicDrops,
      drawn: d.rainDrops,
      pool: d.rainPool,
      asked: d.toxicDensityAsked,
      intensity: d.toxicIntensity,
      full: g.constants().TOXIC_DROPS_IN_FLIGHT,
    }
  })

// **The control, first.** Before any shower the sky must be dry — otherwise
// "drops are drawn during rain" is satisfied by a layer that always draws.
const dry = await read()
if (dry.real !== 0 || dry.drawn !== 0) {
  fail(`the sky is not dry before the first shower: ${JSON.stringify(dry)}`)
} else ok('control: no real drops and nothing drawn before the shower')

// Wait for the shower. `WEATHER=toxic` makes the scheduler pick rain every time,
// so this is a wait on the effect's own cadence, not on a coin flip. Polled on
// the condition rather than slept against `EFFECT_INTERVAL_MIN`, which is a
// tunable and would expire this check the day it moves.
const wet = await page
  .waitForFunction('window.__game.debug().toxicDrops > 0', null, { timeout: 120_000 })
  .then(() => read())
  .catch(() => null)

if (!wet) {
  fail(
    'no toxic drop ever reached the game client. The server spawns them and ' +
      'broadcasts projectile_spawn; somewhere between the mirror, syncProjectiles ' +
      'and KIND_BY_WEAPON_KEY the count is zero — and under T20.05 that is a dry sky',
  )
} else {
  ok(`the game client has ${wet.real} real toxic drop(s) in the air`)

  // **Both ends.** The count the server put in the air, and the sheet drawn from
  // it. Before T20.05 the right-hand number was the constant 260 and the left-hand
  // one was never read at all.
  const want = Math.max(0, Math.min(1, wet.real / wet.full))
  if (Math.abs(wet.asked - want) > 1e-6) {
    fail(
      `the emitter asked for ${wet.asked} with ${wet.real} real drops and ` +
        `TOXIC_DROPS_IN_FLIGHT ${wet.full} — expected ${want}`,
    )
  } else ok(`density ${wet.asked.toFixed(2)} derived from ${wet.real} real drops`)

  // And it reaches the screen: the ramp takes ~1.5 s, so give it one.
  await sleep(1600)
  const drawn = await read()
  if (drawn.drawn <= 0) {
    fail(
      `the emitter drew ${drawn.drawn} droplets while ${drawn.real} real drops were ` +
        `falling — the derivation is right and nothing carried it to the screen (§B21)`,
    )
  } else if (drawn.drawn > drawn.pool) {
    fail(`drew ${drawn.drawn} droplets from a pool of ${drawn.pool}`)
  } else {
    ok(`the sheet is drawn in the game scene: ${drawn.drawn} of ${drawn.pool} droplets`)
  }
  await shot('toxic-rain-game')
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
