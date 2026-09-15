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
import { startStack, enterBattle, tally, sleep, freePort } from './harness.mjs'

const PORT = await freePort()
const { fail, ok, finish } = tally('toxic-rain-game')

/**
 * This check's own warmup, not the shipped `WARMUP_SECONDS`. Both servers below
 * waited out a full warmup before the first shower could start, and neither half
 * is about warmup. The dry-sky control still reads before the first drop:
 * `WEATHER=toxic` telegraphs for `EFFECT_TELEGRAPH` after play begins.
 */
const WARMUP_S = 2

const stack = await startStack({
  port: PORT,
  label: 'toxic-rain-game',
  env: {
    WEATHER: 'toxic',
    BOT_COUNT: '0',
    LOBBY_BOT_TIMEOUT: '3',
    DEV_WARMUP_SECONDS: String(WARMUP_S),
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
      // T21.31: where the streaks were drawn, world px — the real drops themselves.
      drawnAt: d.toxicDropsDrawn ?? [],
      me: d.player ? { x: d.player.x, y: d.player.y } : null,
      intensity: d.toxicIntensity,
      t: d.roundTime ?? 0,
      health: d.health,
      // The wire's poisoned bit, beside the health it explains (§A39).
      poisoned: d.hudBars?.poisoned ?? null,
    }
  })

/**
 * The lowest rock above the local player's head, world y, or `null` under open sky.
 * T21.31: a drawn drop below this row and over her would be rain inside the shelter.
 */
const roofY = (pg) =>
  pg.evaluate(() => {
    const g = window.__game
    const p = g.debug().player
    if (!p) return null
    for (let y = Math.round(p.y - g.constants().PLAYER_H); y >= 0; y -= 1) {
      if (g.core.solidAt(Math.round(p.x), y)) return y
    }
    return null
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
async function followShower(readFn, k, roof = null) {
  let s = await readFn()
  const start = s
  let last = s.health
  let lost = 0
  let sawPoison = !!s.poisoned
  let maxDrops = s.real
  let clean = 0
  // T21.31: the picture half. Polls with a drawn drop over her head within the splash,
  // and — under a roof — drawn drops between the roof and her feet, which must not exist.
  let overhead = 0
  let underRoof = 0
  const look = (x) => {
    if (!x.me || !x.drawnAt) return
    for (const d of x.drawnAt) {
      if (Math.abs(d.x - x.me.x) > k.TOXIC_SPLASH_R || d.y > x.me.y) continue
      if (roof !== null && d.y > roof) underRoof++
      else overhead++
    }
  }
  look(s)
  const limit = s.t + k.TOXIC_DURATION + k.TOXIC_POISON_DURATION + 20
  while (s.t < limit) {
    await sleep(100)
    s = await readFn()
    if (s.health < last) lost += last - s.health
    last = s.health
    sawPoison ||= !!s.poisoned
    maxDrops = Math.max(maxDrops, s.real)
    look(s)
    // Done once the sky has been dry and the player clean for a whole poison.
    clean = s.real === 0 && !s.poisoned ? clean + 1 : 0
    if (clean * 0.1 >= k.TOXIC_POISON_DURATION + 1) break
  }
  return { start, end: s, lost, sawPoison, maxDrops, overhead, underRoof }
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

  // **Both ends, by construction since T21.31.** The rain is drawn as a streak at each
  // real drop, so the count drawn is the count in the air. Frozen for the read: the scene
  // syncs its projectiles and draws the rain in one update, and a message landing between
  // two reads would compare two moments.
  await page.evaluate(() => window.__game.freeze(true))
  const both = await read()
  // **And where, not only how many.** The count alone was measured blind: streaks drawn
  // 200 px from every real drop kept it equal, and kept the over-her-head count below
  // passing too (86 hits against 39 unplanted). So every streak's position is compared
  // with the ordnance layer's live drops, read in the same frozen frame — the state the
  // streaks were drawn from, and the state `syncProjectiles` fills from the server's.
  const places = await page.evaluate(() => {
    const d = window.__game.debug()
    return { drawn: d.toxicDropsDrawn ?? null, live: d.toxicDropsLive ?? null }
  })
  await page.evaluate(() => window.__game.freeze(false))
  if (both.real <= 0) fail('the real drops were gone by the time both ends were read — nothing was compared')
  else if (both.drawn !== both.real) {
    fail(
      `the layer drew ${both.drawn} toxic streaks with ${both.real} real drops in the air — ` +
        `the rain on the screen is not the rain that poisons (T20.05, T21.31)`,
    )
  } else ok(`the toxic rain drawn is the real rain: ${both.drawn} streaks at ${both.real} drops`)
  if (!Array.isArray(places.drawn) || !Array.isArray(places.live)) {
    fail(`debug() does not carry both drop lists (drawn ${typeof places.drawn}, live ${typeof places.live}) — the positions cannot be compared`)
  } else {
    const key = (p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`
    const live = new Set(places.live.map(key))
    const stray = places.drawn.filter((p) => !live.has(key(p)))
    if (places.live.length === 0) fail('no live drop in the frozen frame — the position comparison compared nothing')
    else if (stray.length > 0 || places.drawn.length !== places.live.length) {
      fail(
        `${stray.length} of ${places.drawn.length} toxic streaks are not at a live drop ` +
          `(e.g. drawn ${JSON.stringify(stray[0])}, live ${JSON.stringify(places.live[0])}) — the picture is not where the poison is`,
      )
    } else ok(`every toxic streak is at a live drop: ${places.drawn.length} of ${places.live.length}`)
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
    // T21.31: drawn drops did come down over her while she was hurt. **A presence
    // control, not the proof that picture and poison agree** — measured, it still passes
    // with every streak drawn 200 px off (the shower scatters drops near her either way).
    // The per-streak position match above is the assertion that catches that.
    if (!(shower.overhead > 0)) {
      fail('the player was in a shower and no drawn drop ever came down within TOXIC_SPLASH_R of her — the damage below is not the picture')
    } else ok(`drawn toxic drops came down over her ${shower.overhead} time(s) during the shower`)
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
  port: await freePort(),
  label: 'toxic-rain-game/roof',
  env: {
    WEATHER: 'toxic',
    BOT_COUNT: '0',
    LOBBY_BOT_TIMEOUT: '3',
    FIXED_SEED: '2',
    DEV_WARMUP_SECONDS: String(WARMUP_S),
  },
})
try {
  const rc = await roofStack.openClient({ name: 'ana' })
  await enterBattle(rc.page, { waitPlaying: true, label: 'toxic-rain-game/roof' })
  const readRoof = () =>
    rc.page.evaluate(() => {
      const d = window.__game.debug()
      return {
        real: d.toxicDrops,
        t: d.roundTime ?? 0,
        health: d.health,
        poisoned: d.hudBars?.poisoned ?? null,
        drawnAt: d.toxicDropsDrawn ?? [],
        me: d.player ? { x: d.player.x, y: d.player.y } : null,
      }
    })
  const covered = await roofed(rc.page)
  const roofRow = await roofY(rc.page)
  const started = await rc.page
    .waitForFunction('window.__game.debug().toxicDrops > 0', null, { timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
  if (covered !== true) {
    fail(`FIXED_SEED 2 no longer spawns under rock (roofed: ${covered}) — the roof control is not a control`)
  } else if (!started) {
    fail('no toxic drop reached the roofed client, so "no damage under rock" would be a dry sky')
  } else {
    const shower = await followShower(readRoof, k, roofRow)
    // T21.31, the picture: no drawn drop between her roof and her feet. Its presence
    // control is the open-sky half above, where drawn drops did come down over her.
    if (shower.underRoof > 0) fail(`${shower.underRoof} drawn toxic drops came down under the roof over her`)
    else ok(`under rock: no drawn drop below her roof at row ${roofRow} (${shower.overhead} landed on it)`)
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
