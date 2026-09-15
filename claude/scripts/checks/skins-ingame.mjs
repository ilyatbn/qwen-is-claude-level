#!/usr/bin/env node
/**
 * A player's chosen skin reaches the **game**, not just the menu (T20.04).
 *
 *   node scripts/checks/skins-ingame.mjs
 *
 * Reported: *"skins don't work. Everyone looks the same. I set myself to a
 * zombie in the menu and it doesn't change in game."* Correct in every word.
 * The whole pipeline worked — menu → `localStorage` → wire → seat → back out in
 * `lobby_state` and `player_join` — and `GameScene` threw the id away in three
 * places and built every body with `new PlayerView(this, 0)`.
 *
 * ## Why this check has to exist, and why nothing caught it
 *
 * `scripts/checks/skins.mjs` never enters a game: it steps the picker, checks
 * the preview and `localStorage`, and goes back to the menu. `lobby.test.ts`
 * asserts `skinId: 2` survives parsing. Both are true and neither is the bug.
 * **Nothing anywhere asserted a rendered player's skin**, so the fix breaks no
 * existing test — which is exactly why it survived (§C2, and `docs/72`'s "assert
 * on rendered pixels").
 *
 * ## The shape of the assertion
 *
 * Three clients: **ana on skin 0, bo on skin 4, and cy on skin 0**. One page's
 * camera frames each body in turn, so every sample shares a renderer, a
 * day-cycle instant and a camera transform. Each body's rect is read **twice** —
 * with the bodies drawn, and with them hidden — and the pixels that differ between
 * the two are **that body's own pixels**. The comparison is made on those pixels
 * only: ana against bo is the subject, ana against cy (same skin, other ground) is
 * the control, and the subject must differ by `SKIN_RATIO` times what the control
 * does.
 *
 * ## The version before this one compared means against the ground, and expired
 *
 * T20.04–T21.20 compared **rect means**: "the bodies differ by more than 1.5x the
 * ground behind them does". The ground is scenery, so the bar moved whenever the
 * scenery did — pads (T21.12: ground 32 → 85), the mountain band (T21.20: 37 → 58),
 * and in T21.37 the sky itself: bodies **61.0 in every run** while the ground ranged
 * **27.2 to 47.4** run to run (the sky colour behind two spawn points at different
 * heights, at whatever instant of the day warmup is sampled), red whenever it passed
 * 40.7. Nothing about the skins changed between a red run and a green one. The
 * algebra it rested on was not a bound either: identical sprites give
 * `mean((1 - alpha) * (groundA - groundB))`, which can exceed the full-rect ground
 * difference whenever that difference cancels behind the opaque part.
 *
 * Masking removes the scenery from the comparison instead of hiding it layer by
 * layer: behind an opaque pixel the ground does not reach the screen at all.
 *
 * **Earlier falsifications, kept because each was a real way to be wrong:** a patch
 * above the head is not the ground behind the body; a remote is drawn from the
 * **interpolation buffer**, so rects come from where ana's page *draws* each body
 * (§C7); and a fixed screen rect is a stamp on an arbitrary part of the sprite.
 *
 * `view.skin` is read too, and it is deliberately **not** the assertion — the
 * bug was precisely that the id was known and not drawn. It is here so a failure
 * says which half broke.
 */
import { startStack, enterBattle, standStill, sleep, shotsDir, freePort } from './harness.mjs'
import { toScreen, patchRGBA } from './pixels.mjs'
import { join } from 'node:path'

const PORT = await freePort()
const { fail, ok, finish } = (await import('./harness.mjs')).tally('skins-ingame')

/**
 * Recruit and Revenant — `assets/skins.json` ids 0 and 4, `character_player_`
 * and `character_zombie_`. Different **sprite sheets** rather than a tint of one.
 */
const SKIN_A = 0
const SKIN_B = 4
/** A **third** client, on the same skin as the first — the control. */
const SKIN_C = SKIN_A

/**
 * A pixel belongs to a body when showing the bodies moves one of its channels by
 * more than this. Measured: the `PLAYER_W x PLAYER_H` box sits **inside** the drawn
 * sprite (~53x77 screen px against a 32x56 box), so most of 1792 px are body (1757–1770
 * measured). **Not scenery-proof:** in one run bo fell to 1274 px, because Revenant pixels
 * within this delta of the hillside dropped out. That raises the different-skin score (a
 * pixel on one body only costs 1). The same-skin control read 0.026 in every run. What takes
 * the scenery out of the verdict is comparing body pixels with body pixels, instead of
 * dividing by a ground difference.
 */
const MASK_DELTA = 24
/** The subject pair must differ by this many times what the same-skin pair does. */
const SKIN_RATIO = 3
/** Sub-pixel placement: two bodies are compared at the best offset within this many px. */
const ALIGN = 2

const stack = await startStack({
  port: PORT,
  label: 'skins-ingame',
  env: {
    // A bot is a player and every bot is skin 0, so one wandering into a sampled
    // rect would be indistinguishable from the bug.
    BOT_COUNT: '0',
    // Long enough for two cold pages to be seated before §E2 starts the round
    // without the second one — `two-clients` pays for this same knob.
    LOBBY_BOT_TIMEOUT: '120',
    FIXED_SEED: '4242',
    MAP_SCALE: 'small',
    // §F9's veil multiplies every colour difference on screen by 0.2, and a
    // meteor would carve the ground under a sampled rect.
    WEATHER: 'off',
  },
})

const a = await stack.openClient({ name: 'ana', skin: SKIN_A })
const b = await stack.openClient({ name: 'bo', skin: SKIN_B })
const c = await stack.openClient({ name: 'cy', skin: SKIN_C })
const dbg = (x) => x.page.evaluate('window.__game.debug()')

await enterBattle(a.page, { expectPlayers: 3, label: 'skins-ingame/ana' })
await enterBattle(b.page, { press: false, expectPlayers: 3, label: 'skins-ingame/bo' })
await enterBattle(c.page, { press: false, expectPlayers: 3, label: 'skins-ingame/cy' })

// Settled, and **all facing the same way**: a sprite is mirrored by its owner's
// aim, so two bodies looking in opposite directions differ whatever they wear.
for (const x of [a, b, c]) {
  await standStill(x.page)
  await x.page.mouse.move(1200, 360)
}
await sleep(400)

// **`watch`, not walking**: one page, one camera, framing each body in turn
// (`__game.watch` snaps this client's camera to a world point). **Where ana's page
// DRAWS each body**, not where each client says it is (§C7).
const drawn = await a.page.evaluate('window.__game.debug().drawnPlayers')
const seat = async (x) => (await dbg(x)).me
const [ia, ib, ic] = [await seat(a), await seat(b), await seat(c)]
const at = (id) => (drawn ?? []).find((p) => p.id === id)
const [pa, pb, pc] = [at(ia), at(ib), at(ic)]
if (!pa || !pb || !pc) {
  fail(
    `ana's page is not drawing all three bodies: ${JSON.stringify(drawn)} for seats ` +
      `${JSON.stringify([ia, ib, ic])}`,
  )
  await finish()
}
ok(
  `three bodies framed one at a time by one camera: bo ${Math.hypot(pb.x - pa.x, pb.y - pa.y).toFixed(0)} px ` +
    `from ana, cy ${Math.hypot(pc.x - pa.x, pc.y - pa.y).toFixed(0)} px`,
)

// Daylight, asserted rather than assumed: `renderRemotes` culls a remote outside
// the local player's field of view **at night** (`docs/14` §5).
const dark = (await dbg(a)).darkness ?? 0
if (dark > 0.01) {
  fail(`it is dark (${dark.toFixed(2)}) and a remote outside the fov is culled, not drawn`)
  await finish()
}
ok(`control: it is daylight (darkness ${dark.toFixed(2)}), so nothing is culled by the fov`)

// --- the ids reached the views (not the assertion; so a red below can be read) --
const drawnSkins = await a.page.evaluate('window.__game.debug().drawnSkins')
if (!drawnSkins || typeof drawnSkins !== 'object') {
  fail(`debug().drawnSkins is ${JSON.stringify(drawnSkins)} — the field does not exist`)
  await finish()
}
const seen = Object.values(drawnSkins).sort((x, y) => x - y)
const wanted = [SKIN_A, SKIN_B, SKIN_C].sort((x, y) => x - y)
if (seen.length !== 3 || seen.some((v, i) => v !== wanted[i])) {
  fail(
    `the views were built with ${JSON.stringify(drawnSkins)}, not ${JSON.stringify(wanted)} ` +
      `— the id did not reach the construction site`,
  )
} else ok(`all three views hold the id they were given: ${JSON.stringify(drawnSkins)}`)

// --- the pixels -------------------------------------------------------------
const C = await a.page.evaluate('window.__game.constants()')

/**
 * Frame a world point and read the body's own box **twice**, with the bodies drawn
 * and hidden, in one frozen frame. Integer rects of one size for every body, so the
 * three reads line up pixel for pixel.
 *
 * Pads and the parallax band are still hidden: masking makes the comparison immune
 * to what is behind a body, but a pad arch *in front of* the feet would be masked in
 * as body.
 */
async function frame(page, wx, wy, tag) {
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [wx, wy])
  await page.evaluate(() => window.__game.showPads?.(false))
  await page.evaluate(() => window.__game.setParallaxVisible?.(false))
  await sleep(250)
  const s = await toScreen(page, wx, wy)
  if (!s.onScreen) return null
  const w = Math.round(C.PLAYER_W * s.scale)
  const h = Math.round(C.PLAYER_H * s.scale)
  const rect = {
    x: Math.max(Math.ceil(s.bounds.left), Math.round(s.x - w / 2)),
    y: Math.max(Math.ceil(s.bounds.top), Math.round(s.y - h / 2)),
    w,
    h,
  }
  await page.evaluate(() => window.__game.freeze(true))
  const body = await patchRGBA(page, rect)
  const roundTime = (await page.evaluate('window.__game.debug().roundTime')) ?? NaN
  await page.screenshot({ path: join(shotsDir, `skins-ingame-${tag}.png`) })
  console.log(`  shot: shots/skins-ingame-${tag}.png`)
  await page.evaluate(() => window.__game.setActorsVisible(false))
  const ground = await patchRGBA(page, rect)
  await page.evaluate(() => window.__game.setActorsVisible(true))
  await page.evaluate(() => window.__game.freeze(false))
  await page.evaluate(() => window.__game.showPads?.(true))
  await page.evaluate(() => window.__game.setParallaxVisible?.(true))
  return spriteOf(body, ground, roundTime)
}

/** The body's own pixels: the mask, plus the rect means the old assertion used (logged only). */
function spriteOf(body, ground, roundTime) {
  const n = body.w * body.h
  const mask = new Uint8Array(n)
  let count = 0
  const mean = (p) => {
    let r = 0
    let g = 0
    let bl = 0
    for (let i = 0; i < p.rgba.length; i += 4) {
      r += p.rgba[i]
      g += p.rgba[i + 1]
      bl += p.rgba[i + 2]
    }
    return { r: r / n, g: g / n, b: bl / n }
  }
  for (let j = 0; j < n; j++) {
    const i = j * 4
    const d = Math.max(
      Math.abs(body.rgba[i] - ground.rgba[i]),
      Math.abs(body.rgba[i + 1] - ground.rgba[i + 1]),
      Math.abs(body.rgba[i + 2] - ground.rgba[i + 2]),
    )
    if (d > MASK_DELTA) {
      mask[j] = 1
      count++
    }
  }
  return { w: body.w, h: body.h, px: body.rgba, mask, count, bodyMean: mean(body), groundMean: mean(ground), roundTime }
}

/**
 * How different two bodies' own pixels are, 0..1, at their best alignment.
 *
 * Over every pixel either body covers: where both do, the largest channel difference
 * / 255; where only one does, 1 (the silhouettes disagree). Identical sprites score
 * near 0 whatever they stand in front of — the loss is only a pixel whose colour is
 * within `MASK_DELTA` of its ground, masked out on one body and not the other.
 */
function pairScore(p, q) {
  let best = Infinity
  for (let dy = -ALIGN; dy <= ALIGN; dy++) {
    for (let dx = -ALIGN; dx <= ALIGN; dx++) {
      let union = 0
      let cost = 0
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const xq = x + dx
          const yq = y + dy
          const inQ = xq >= 0 && xq < q.w && yq >= 0 && yq < q.h
          const ip = y * p.w + x
          const iq = yq * q.w + xq
          const mp = p.mask[ip] === 1
          const mq = inQ && q.mask[iq] === 1
          if (!mp && !mq) continue
          union++
          if (mp && mq) {
            const a4 = ip * 4
            const b4 = iq * 4
            cost +=
              Math.max(
                Math.abs(p.px[a4] - q.px[b4]),
                Math.abs(p.px[a4 + 1] - q.px[b4 + 1]),
                Math.abs(p.px[a4 + 2] - q.px[b4 + 2]),
              ) / 255
          } else cost += 1
        }
      }
      if (union > 0) best = Math.min(best, cost / union)
    }
  }
  return best
}

const fa = await frame(a.page, pa.x, pa.y, 'ana-recruit')
const fb = await frame(a.page, pb.x, pb.y, 'bo-revenant')
const fc = await frame(a.page, pc.x, pc.y, 'cy-recruit')
await a.page.evaluate(() => window.__game.watch(null))
if (!fa || !fb || !fc) {
  fail('a body could not be framed, so the comparison below is not a comparison')
  await finish()
}

const delta = (u, v) => Math.hypot(u.r - v.r, u.g - v.g, u.b - v.b)
for (const [tag, f] of [['ana', fa], ['bo', fb], ['cy', fc]]) {
  console.log(
    `  probe: ${tag} ${f.count} body px of ${f.w}x${f.h}; rect mean body-vs-ground ` +
      `${delta(f.bodyMean, f.groundMean).toFixed(1)}; round time ${Number(f.roundTime).toFixed(2)} s`,
  )
}
// The old instrument, logged so its drift stays visible: the scenery term it divided by.
console.log(
  `  probe (old means, not asserted): ana-bo bodies ${delta(fa.bodyMean, fb.bodyMean).toFixed(1)} ground ` +
    `${delta(fa.groundMean, fb.groundMean).toFixed(1)}; ana-cy bodies ${delta(fa.bodyMean, fc.bodyMean).toFixed(1)} ` +
    `ground ${delta(fa.groundMean, fc.groundMean).toFixed(1)}`,
)

// **Presence.** Every number below is about body pixels; a rect the bodies did not
// change would make them about nothing. A quarter of the box is far under any skin.
const minBody = Math.round(fa.w * fa.h * 0.25)
let present = true
for (const [tag, f] of [['ana', fa], ['bo', fb], ['cy', fc]]) {
  if (f.count < minBody) {
    fail(`${tag}'s rect has ${f.count} body px (< ${minBody}) — no body is framed there`)
    present = false
  }
}
if (present) ok(`each rect holds a body: ${fa.count}, ${fb.count}, ${fc.count} px (>= ${minBody})`)

const same = pairScore(fa, fc)
const diff = pairScore(fa, fb)
console.log(`  probe: body pixels differ — ana-cy (same skin) ${same.toFixed(3)}, ana-bo ${diff.toFixed(3)}`)

// **The control asserts the absence**: the same skin on different ground must score
// low in absolute terms, or the mask is letting scenery in and the ratio below would
// be comparing two backgrounds.
if (same * SKIN_RATIO >= 1) {
  fail(
    `control: two bodies on the SAME skin (${SKIN_A}) differ by ${same.toFixed(3)} on their own pixels — ` +
      `scenery is leaking into the mask, so the comparison below proves nothing`,
  )
} else {
  ok(`control: two bodies on the same skin differ by ${same.toFixed(3)} on their own pixels`)
}

if (diff < same * SKIN_RATIO) {
  fail(
    `the skin is not reaching the screen: skins ${SKIN_A} and ${SKIN_B} differ by ${diff.toFixed(3)} on ` +
      `their own pixels against ${same.toFixed(3)} for the same skin (needs ${SKIN_RATIO}x) — skin ${SKIN_B} ` +
      `is being drawn as skin ${SKIN_A}`,
  )
} else {
  ok(
    `skins ${SKIN_A} and ${SKIN_B} render differently: ${diff.toFixed(3)} against ${same.toFixed(3)} for ` +
      `the same skin — ${(diff / Math.max(same, 1e-6)).toFixed(1)}x`,
  )
}

for (const x of [a, b, c]) {
  if (x.pageErrors.length) fail(`${x.name} page errors: ${x.pageErrors.join(' | ')}`)
  else ok(`no page errors (${x.name})`)
}

await finish()
