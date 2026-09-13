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
    // **Pinned for the damage half (T21.25).** Where a shower's drops land is a
    // seeded draw, and one shower is one draw: measured in the open over six
    // seeds, five lost 65-97 health and one (4242) lost nothing. The population
    // claim lives in Rust (`a_shower_hurts_the_player_in_the_open_and_never_the_
    // one_under_rock`, six seeds); this check asserts the *hops* — server poison
    // -> wire -> the health the client shows — so it wants the seed that is
    // measured wet, twice identically (84 lost, 4 poisonings). Seed 1 spawns
    // under open sky; the check says so if that ever stops being true.
    FIXED_SEED: '1',
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
      t: d.roundTime ?? 0,
      health: d.health,
      // The wire's poisoned bit, beside the health it explains (§A39).
      poisoned: d.hudBars?.poisoned ?? null,
    }
  })

/** Is there rock anywhere above the local player's head? */
const roofed = (pg) =>
  pg.evaluate(() => {
    const g = window.__game
    const p = g.debug().player
    if (!p) return null
    for (let y = 0; y < p.y - g.constants().PLAYER_H; y += 2) {
      if (g.core.solidAt(Math.round(p.x), y)) return true
    }
    return false
  })

/**
 * Follow one shower from its first drop until the rain is gone and the last
 * poison has run out, in the **simulation's** clock (T21.23): what health was
 * lost, whether the wire ever said "poisoned", and how much rain fell.
 */
async function followShower(readFn, k) {
  let s = await readFn()
  const start = s
  let last = s.health
  let lost = 0
  let sawPoison = !!s.poisoned
  let maxDrops = s.real
  let clean = 0
  const limit = s.t + k.TOXIC_DURATION + k.TOXIC_POISON_DURATION + 20
  while (s.t < limit) {
    await sleep(100)
    s = await readFn()
    if (s.health < last) lost += last - s.health
    last = s.health
    sawPoison ||= !!s.poisoned
    maxDrops = Math.max(maxDrops, s.real)
    // Done once the sky has been dry and the player clean for a whole poison.
    clean = s.real === 0 && !s.poisoned ? clean + 1 : 0
    if (clean * 0.1 >= k.TOXIC_POISON_DURATION + 1) break
  }
  return { start, end: s, lost, sawPoison, maxDrops }
}

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

// --- T21.25: does the shower actually hurt? ---------------------------------
//
// Everything above is about getting the sheet on screen, and not one line of it
// reads a health bar — so a rain that stopped poisoning anyone would pass it.
// Asked from play: *"ive never seen any actual damage from toxic rains"*. Measured
// before changing anything: it does damage (65-97 health a shower in the open on
// five of six seeds). This is the assertion that would notice it stopping.
const k = await page.evaluate(() => window.__game.constants())
const oneHit = k.TOXIC_POISON_DPS * k.TOXIC_POISON_DURATION
if (wet) {
  // **The absence control, first**: nothing hurt her before the rain did. Without
  // it "health fell during the shower" is satisfied by a fall, a mine or a bot.
  if (wet.health !== dry.health) {
    fail(`health moved from ${dry.health} to ${wet.health} before the first drop — something other than the rain`)
  } else ok(`control: health ${dry.health} unchanged from the dry sky to the first drop`)

  const open = await roofed(page)
  if (open !== false) {
    fail(
      `FIXED_SEED 1 no longer spawns under open sky (roofed: ${open}) — the damage half ` +
        'below would be measuring shelter, not rain; re-pick the seed by measurement',
    )
  } else {
    const shower = await followShower(read, k)
    console.log(
      `  open sky: health ${shower.start.health} -> ${shower.end.health} (lost ${shower.lost.toFixed(1)}), ` +
        `poisoned seen ${shower.sawPoison}, up to ${shower.maxDrops} drops in the air`,
    )
    // Both ends (§A39): the wire's flag and the health it costs.
    if (!shower.sawPoison) fail('the player stood in a whole shower and the wire never said poisoned')
    else ok('the wire said poisoned during the shower')
    // `lost > 0` beside the pinned floor: the floor is derived from
    // `TOXIC_POISON_DPS`, so a poison tuned to 0 would lower it to 0 and pass.
    if (!(shower.lost > 0) || shower.lost < oneHit) {
      fail(
        `a whole shower in the open cost ${shower.lost.toFixed(1)} health — less than one poisoning ` +
          `(TOXIC_POISON_DPS x TOXIC_POISON_DURATION = ${oneHit.toFixed(1)})`,
      )
    } else ok(`standing in the open cost ${shower.lost.toFixed(1)} health (one poisoning is ${oneHit.toFixed(1)})`)
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')
await stack.close()

// --- the roof control: same rain, a player under rock -------------------------
//
// "The open player lost health" is also satisfied by rain that poisons everyone
// regardless of cover. Seed 2 spawns under rock (measured: 0 health lost while
// the shower fell). The *presence* half is asserted too — rain must have been
// falling — or "no damage" passes for a dry sky.
//
// **What this control covers, measured by planting both.** A splash that poisons
// every player whatever the distance reds it. Disabling `poison_lands` — the roof
// test itself — does **not**: under this much rock the drops land on the roof,
// further than `TOXIC_SPLASH_R` from her, and the roof test is never asked. That
// rule (a drop that drifts in through a cave mouth) is geometry, and Rust owns
// it: `a_roof_stops_the_poison_and_open_sky_does_not`.
const roofStack = await startStack({
  port: PORT + 1,
  label: 'toxic-rain-game/roof',
  env: { WEATHER: 'toxic', BOT_COUNT: '0', LOBBY_BOT_TIMEOUT: '3', FIXED_SEED: '2' },
})
try {
  const rc = await roofStack.openClient({ name: 'ana' })
  await enterBattle(rc.page, { waitPlaying: true, label: 'toxic-rain-game/roof' })
  const readRoof = () =>
    rc.page.evaluate(() => {
      const d = window.__game.debug()
      return { real: d.toxicDrops, t: d.roundTime ?? 0, health: d.health, poisoned: d.hudBars?.poisoned ?? null }
    })
  const covered = await roofed(rc.page)
  const started = await rc.page
    .waitForFunction('window.__game.debug().toxicDrops > 0', null, { timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
  if (covered !== true) {
    fail(`FIXED_SEED 2 no longer spawns under rock (roofed: ${covered}) — the roof control is not a control`)
  } else if (!started) {
    fail('no toxic drop reached the roofed client, so "no damage under rock" would be a dry sky')
  } else {
    const shower = await followShower(readRoof, k)
    if (shower.maxDrops <= 0) fail('the roofed client saw no rain at all during its shower')
    else if (shower.lost > 0 || shower.sawPoison) {
      fail(
        `a player under rock lost ${shower.lost.toFixed(1)} health (poisoned seen ${shower.sawPoison}) ` +
          'while the rain fell — cover is not protecting anyone in the networked game',
      )
    } else {
      ok(`control: under rock, ${shower.maxDrops} drops in the air and no health lost, never poisoned`)
    }
  }
  if (rc.pageErrors.length) fail(`page errors (roof): ${rc.pageErrors.slice(0, 3).join(' | ')}`)
} finally {
  await roofStack.close()
}

await finish()
