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
 * ## The shape of the assertion, and the version of it that was wrong
 *
 * Three clients: **ana on skin 0, bo on skin 4, and cy on skin 0**. One page's
 * camera frames each body in turn, so every sample shares a renderer, a
 * day-cycle instant and a camera transform.
 *
 * Each body's rect is read **twice** — with the bodies drawn, and with them
 * hidden — so the ground behind each one is measured rather than assumed. The
 * assertion is then an inequality with a proof rather than a threshold: a rect is
 * `alpha * sprite + (1 - alpha) * ground`, so two rects of **identical** sprites
 * differ by `(1 - alpha) * (groundA - groundB)`, which is strictly *less* than
 * the ground difference. Two different sprites have no such bound. "The bodies
 * differ by more than the ground does" is therefore a property only different
 * skins can have, and no number had to be chosen to make it pass.
 *
 * `cy` wears ana's skin and stands somewhere else, and asserts the other half:
 * two identical sprites must **fail** that bar. Without it the inequality is a
 * claim about one pair.
 *
 * **Three earlier versions of this check passed with the bug deliberately
 * restored**, and each was caught only by running the falsification rather than
 * reasoning about it (`CLAUDE.md`: *"ask what a passing assertion rules out"*).
 * In order: a background patch above the head is not the background *behind* the
 * body (two bodies on different ground differ by 36.7 with both on skin 0); a
 * remote is drawn from the **interpolation buffer**, so a rect built from that
 * client's own reported position caught 36 % as much sprite as one on the local
 * player (§C7); and a fixed 16x16 screen rect is a stamp on a 32x56 sprite, so
 * how much sprite it contains varies per body and the inequality collapses.
 * Measured now: with the fix, bodies 61.0 against ground 26.9; with the bug,
 * **0.6** against 28.5.
 *
 * `view.skin` is read too, and it is deliberately **not** the assertion — the
 * bug was precisely that the id was known and not drawn. It is here so a failure
 * says which half broke: an id that never arrived is a wire problem, and an id
 * that arrived with matching pixels is this bug returning.
 */
import { startStack, enterBattle, standStill, sleep, shotsDir } from './harness.mjs'
import { toScreen, samplePatch, colourDelta } from './pixels.mjs'
import { join } from 'node:path'

const PORT = 3129
const { fail, ok, finish } = (await import('./harness.mjs')).tally('skins-ingame')

/**
 * Recruit and Revenant — `assets/skins.json` ids 0 and 4, `character_player_`
 * and `character_zombie_`. The zombie is the one in the report, and the two are
 * different **sprite sheets** rather than a tint of one, so a difference here
 * cannot come from a tint that would have applied to skin 0 anyway.
 */
const SKIN_A = 0
const SKIN_B = 4
/**
 * A **third** client, on the same skin as the first — the control.
 *
 * Without it the check was measuring position, not skin, and it was caught the
 * only way that is ever caught: by restoring the bug and watching the assertion
 * pass anyway. Two bodies standing on different ground differ by 36.7 with
 * **both** on skin 0, against 90.1 with one on skin 4, so "these two rects
 * differ" rules out nothing. `cy` runs the identical procedure with the property
 * under test removed, and its reading is the floor the real pair must clear.
 */
const SKIN_C = SKIN_A

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
    // meteor would carve the ground under a sampled rect. `crates` excludes
    // weather for the same reason: the subject here is two sprites.
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

// Settled before anything is measured: a body still accelerating is a body that
// has moved between the position read and the screenshot.
//
// **And all facing the same way.** A sprite is mirrored by its owner's aim, so
// two bodies looking in opposite directions differ in pixels whatever they are
// wearing — a confound that belongs to the mouse and not to the skin. Aim is set
// per client, so each page's own pointer goes to the same place on its screen.
for (const x of [a, b, c]) {
  await standStill(x.page)
  await x.page.mouse.move(1200, 360)
}
await sleep(400)

// --- frame each body with the same camera -----------------------------------
//
// **`watch`, not walking.** Two spawn points on a Small map are 1544 px apart
// and the camera shows ~640x360 at `CAMERA_ZOOM = 2`, so an approach loop is the
// obvious way to get both bodies into one shot — and it does not work: measured,
// ana closed 240 px of 1544 in sixty seconds of a held key with jetpack hops,
// because the ground between two spawn points is not a corridor. A check whose
// subject is two sprites should not contain a pathfinder.
//
// `__game.watch(x, y)` snaps this client's camera to a world point, which is the
// hook `crates` added for photographing a falling crate. So **one page, one
// camera, one client** frames each body in turn. What that gives up against a
// single shot is ~200 ms between two screenshots of a world in which both bodies
// are standing still; what it keeps is everything the "same frame" rule was for
// — one renderer, one day-cycle instant, one lighting state, and the *same*
// camera transform in both samples.
//
// The remaining confound is the scenery behind each body, and that is what the
// background control below measures rather than assumes.
// **Where ana's page DRAWS each body**, not where each client says it is (§C7).
// A remote comes off the interpolation buffer and lags its own client's
// predicted position by design; a rect built from the latter caught 36 % as much
// sprite as one built on the local player, and the check then compared a sprite
// with a hillside and called the difference a skin.
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
// the local player's field of view **at night** (`docs/14` §5), and a culled body
// is an invisible one — which would read exactly like the bug.
const dark = (await dbg(a)).darkness ?? 0
if (dark > 0.01) {
  fail(`it is dark (${dark.toFixed(2)}) and a remote outside the fov is culled, not drawn`)
  await finish()
}
ok(`control: it is daylight (darkness ${dark.toFixed(2)}), so nothing is culled by the fov`)

// --- the ids reached the views ----------------------------------------------
//
// **Not the assertion.** The bug is that the id was known and not drawn, so this
// passing means nothing on its own — it is here so a red below can be read.
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
//
// `toScreen` converts through the **live** camera, never a fixed pixel — the
// three traps `pixels.mjs` documents. A body is `PLAYER_W x PLAYER_H`; the rect
// is a little tighter than that so a neighbouring body or the ground line cannot
// wander into it.
/**
 * The sampled rect is the **body's own box**, in screen pixels, from the live
 * camera scale.
 *
 * The version before this used a fixed 16x16 screen rect, and that was the third
 * thing wrong with this check. At `CAMERA_ZOOM = 2` a body is 32x56 on screen,
 * so a 16x16 stamp lands on some arbitrary patch of it — and *how much sprite*
 * that patch contains varies per body. The algebra below needs the sprite's
 * share of the rect to be a property of the sprite rather than of where the rect
 * happened to fall: measured, two bodies wearing the **same** skin gave 101.8 and
 * 33.6 for body-versus-ground with the stamp, and the inequality that makes this
 * an assertion collapsed with them.
 */
const C = await a.page.evaluate('window.__game.constants()')

/**
 * Frame a world point and read the same rect **twice** — once with the bodies
 * drawn and once with them hidden.
 *
 * The second read is the control, and it is what the first two versions of this
 * check were missing. A character sprite is transparent around its outline, so a
 * rect on a body is part sprite and part whatever that body is standing in front
 * of — and two spawn points 1500 px apart are in front of very different things.
 * Measured with the bug deliberately restored (**every** body built as skin 0):
 * two bodies differed by 74.2 with a background-above-the-head control reading
 * 18.8, and the assertion passed. It was measuring the hillside.
 *
 * With the bodies hidden, the same rect gives that hillside alone. The scene is
 * frozen first because `renderRemotes` rewrites every remote's visibility on
 * every frame, and because one frame diffed against itself has no second instant
 * to disagree with (`setBirdsVisible`'s own comment says this).
 */
async function frame(page, wx, wy, tag) {
  await page.evaluate(([x, y]) => window.__game.watch(x, y), [wx, wy])
  // One frame for the snap to land, then freeze so the two reads below are the
  // same picture with one thing changed.
  await sleep(250)
  const s = await toScreen(page, wx, wy)
  if (!s.onScreen) return null
  const w = C.PLAYER_W * s.scale
  const h = C.PLAYER_H * s.scale
  const rect = { x: s.x - w / 2, y: s.y - h / 2, w, h }
  await page.evaluate(() => window.__game.freeze(true))
  const body = await samplePatch(page, rect)
  await page.screenshot({ path: join(shotsDir, `skins-ingame-${tag}.png`) })
  console.log(`  shot: shots/skins-ingame-${tag}.png`)
  await page.evaluate(() => window.__game.setActorsVisible(false))
  const ground = await samplePatch(page, rect)
  await page.evaluate(() => window.__game.setActorsVisible(true))
  await page.evaluate(() => window.__game.freeze(false))
  return { body, ground }
}

const fa = await frame(a.page, pa.x, pa.y, 'ana-recruit')
const fb = await frame(a.page, pb.x, pb.y, 'bo-revenant')
const fc = await frame(a.page, pc.x, pc.y, 'cy-recruit')
// Hand the camera back, so nothing after this is looking at a frozen point.
await a.page.evaluate(() => window.__game.watch(null))
if (!fa || !fb || !fc) {
  fail('a body could not be framed, so the comparison below is not a comparison')
  await finish()
}

/**
 * How much two bodies differ, against how much the ground behind them does.
 *
 * The algebra is what makes this an assertion rather than a threshold. A rect is
 * `alpha * sprite + (1 - alpha) * ground`, so with **identical** sprites the
 * difference between two rects is `(1 - alpha) * (groundA - groundB)` — strictly
 * *less* than the ground difference. Two different sprites have no such bound.
 * So "the bodies differ by more than the ground does" is a property only
 * different skins can have, and it needs no number chosen to make it pass.
 */
function compare(x, y) {
  return { bodies: colourDelta(x.body, y.body), ground: colourDelta(x.ground, y.ground) }
}

const diff = compare(fa, fb)
const same = compare(fa, fc)

// **Is there a body in the rect at all?** Every number below is about two
// sprites, and a rect that contains no sprite makes all of them about scenery.
// `setActorsVisible(false)` must visibly change each rect, or the framing is
// wrong and the check is measuring the ground three times.
for (const [tag, f] of [['ana', fa], ['bo', fb], ['cy', fc]]) {
  const d = colourDelta(f.body, f.ground)
  console.log(`  probe: ${tag} body-vs-ground ${d.toFixed(1)} (body lum ${f.body.lum.toFixed(1)}, ground lum ${f.ground.lum.toFixed(1)})`)
}

// **The control asserts the absence.** ana and cy wear the same skin and stand
// on different ground, so their bodies must NOT clear the bar — if they do, the
// bar is not measuring the skin. This is the half that caught two earlier
// versions of this check.
const RATIO = 1.5
if (same.bodies >= same.ground * RATIO) {
  fail(
    `control: two bodies on the SAME skin (${SKIN_A}) differ by ${same.bodies.toFixed(1)} ` +
      `against ground of ${same.ground.toFixed(1)} — the measurement clears its own bar ` +
      `without a skin change, so the assertion below proves nothing`,
  )
} else {
  ok(
    `control: two bodies on the same skin differ by ${same.bodies.toFixed(1)} against ground ` +
      `of ${same.ground.toFixed(1)} — under the ${RATIO}x bar, as identical sprites must be`,
  )
}

if (diff.bodies < diff.ground * RATIO) {
  fail(
    `the skin is not reaching the screen: skins ${SKIN_A} and ${SKIN_B} differ by ` +
      `${diff.bodies.toFixed(1)} while the ground behind them differs by ` +
      `${diff.ground.toFixed(1)} (needs ${RATIO}x). Two rects of identical sprites cannot ` +
      `exceed their own ground difference, and these do not — skin ${SKIN_B} is being drawn ` +
      `as skin ${SKIN_A}`,
  )
} else {
  ok(
    `skins ${SKIN_A} and ${SKIN_B} render differently: bodies ${diff.bodies.toFixed(1)} ` +
      `against ground ${diff.ground.toFixed(1)} — ${(diff.bodies / diff.ground).toFixed(1)}x`,
  )
}

for (const x of [a, b, c]) {
  if (x.pageErrors.length) fail(`${x.name} page errors: ${x.pageErrors.join(' | ')}`)
  else ok(`no page errors (${x.name})`)
}

await finish()
