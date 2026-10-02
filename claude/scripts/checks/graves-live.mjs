#!/usr/bin/env node
/**
 * T23.36 — only a player's last grave stays, seen in a running game.
 *
 *   node scripts/checks/graves-live.mjs
 *   node scripts/e2e.mjs graves-live
 *
 * The owner: *"change tombstone behavior to only show the last one for a player."* The rule lives in one place,
 * `game-core`'s `Tombstones::place`, which announces each grave it removes; the client's graves are those
 * announcements. So this asks the client — what it tracks and what it draws — after real deaths on a real server.
 *
 * The deaths come from held poison (`DEV_POISONED`, every player, every tick) at `DEV_START_HEALTH` 1: everyone dies
 * over and over with no choreography (`death.mjs` spends a page of notes on making one self-kill reliable). The
 * control that the rule is being exercised at all: **more deaths than dead players** — a player died twice — or a
 * graveyard of one-per-victim would also be a graveyard of one death each.
 */
import { startStack, enterBattle, tally, sleep, shotsDir, freePort } from './harness.mjs'
import { join } from 'node:path'

const PORT = await freePort()
const { fail, ok, failures } = tally('graves-live')

const stack = await startStack({
  port: PORT,
  label: 'graves-live',
  env: {
    FIXED_SEED: '4242',
    ROUND_SECONDS: '120',
    BOT_COUNT: '2',
    DEV_POISONED: '1',
    DEV_START_HEALTH: '1',
    // No weather: a second killer is not wanted, and none is needed.
    WEATHER: 'off',
  },
})
const { page, dbg, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'graves-live' })

/** Deaths per victim, as the client was told (cumulative). */
const deathsBy = (d) => {
  const m = new Map()
  for (const x of d.observed?.deaths ?? []) m.set(x.victim, (m.get(x.victim) ?? 0) + 1)
  return m
}

// Until at least two players have died at least twice each (the poison is quick at 1 health).
const deadline = Date.now() + 90_000
let d = await dbg()
for (;;) {
  d = await dbg()
  const twice = [...deathsBy(d).values()].filter((n) => n >= 2).length
  if (twice >= 2 || Date.now() > deadline) break
  await sleep(500)
}
// Let the last death's events settle into the mirror and the layer.
await sleep(1000)
d = await dbg()
const by = deathsBy(d)
const total = [...by.values()].reduce((a, b) => a + b, 0)
console.log(`  deaths by player: ${[...by].map(([v, n]) => `${v}×${n}`).join(', ')}`)
if ([...by.values()].filter((n) => n >= 2).length >= 2) ok('control: two players died twice or more')
else fail(`control: fewer than two players died twice in 90 s (${[...by].map(([v, n]) => `${v}×${n}`).join(', ')})`)
if (total > by.size) ok(`control: ${total} deaths of ${by.size} players — more deaths than dead players`)
else fail(`control: ${total} deaths of ${by.size} players — no one died twice, so one-a-player is not asked`)

const drawn = d.gravesDrawnAt ?? []
const owners = new Map()
for (const g of drawn) owners.set(g.owner, (owners.get(g.owner) ?? 0) + 1)
console.log(`  graves drawn by owner: ${[...owners].map(([o, n]) => `${o}×${n}`).join(', ')}; tracked ${d.tombstones}, drawn ${d.tombstonesDrawn}`)
// Both ends: the mirror's count against the layer's.
if (d.tombstones === d.tombstonesDrawn) ok(`all ${d.tombstones} tracked graves are drawn`)
else fail(`${d.tombstones} graves tracked but ${d.tombstonesDrawn} drawn`)
for (const [victim, n] of by) {
  const g = owners.get(victim) ?? 0
  if (g === 1) ok(`player ${victim} died ${n}× and has one grave`)
  else fail(`player ${victim} died ${n}× and has ${g} graves`)
}
for (const [owner, g] of owners) if (!by.has(owner)) fail(`${g} grave(s) of player ${owner}, who never died`)
if (drawn.length === by.size) ok(`${drawn.length} graves for ${by.size} dead players`)
else fail(`${drawn.length} graves for ${by.size} dead players`)
// The glow's colour rides with the grave (`TombstoneLayer.drawn`): two owners, two colours.
const colours = new Set(drawn.map((g) => g.glow))
if (colours.size === owners.size && !colours.has(null)) ok(`each owner's grave glows its own colour (${[...colours].join(' ')})`)
else fail(`grave glows ${[...colours].join(' ')} for ${owners.size} owners`)

await page.screenshot({ path: join(shotsDir, 'graves-live.png') })
if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`)
else ok('no page errors')

await stack.close()
console.log(failures.length ? `\ngraves-live: ${failures.length} FAILED` : '\ngraves-live: ok')
process.exit(failures.length ? 1 : 0)
