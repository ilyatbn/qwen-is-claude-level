#!/usr/bin/env node
/**
 * `durian` — T24.01: the durian tree, its glowing fruit, and the durian grenade, in a real networked round.
 *
 *   node scripts/checks/durian.mjs
 *
 * A classic-look seed whose Small map grows trees (`SEED`), no bots, no weather; the thrower spawns holding durian
 * grenades (`DEV_DURIAN=1` — they grow only on trees).
 *
 * 1. **Both ends, the trees:** `map_init` carried 1–`DURIAN_TREES` trees (`debug().durianTrees`), and the server grew
 *    `DURIAN_FRUIT` fruit on each — the drawn items whose source is `Tree` — every one under its tree's canopy.
 * 2. **The tree is in the picture:** framed and frozen, the frame with the trees against the same frame with them
 *    switched off (`setDurianTreesVisible`) changes a share of the tree's box past `TREE_MIN`; controls — the frame
 *    with them off drawn twice is identical, and a box beside the tree does not change.
 * 3. **The fruit glow green:** the frame with the pickups against them hidden (`setItemsVisible`) paints a ring round
 *    each fruit, and greener than it was (G − R rises); control: hidden twice, identical.
 * 4. **The grenade bursts mid-air into four, and four purple clouds:** thrown up-right, `DURIAN_PIECES` piece
 *    projectiles are drawn (distinct ids) and as many `DurianGas` clouds held; with the effects hidden as control,
 *    each cloud paints a ring at half its radius, and what it paints is purple (blue and red over green).
 * 5. **The alien cow (task 4):** one is drawn by each tree (`__game.cows()`, both ends against the trees); framed, the
 *    cow is in the picture against the animals hidden (`setAnimalsVisible`, control: hidden twice identical); and
 *    grazing by its tree it **reaches its pink tongue** — over a few seconds of frames the cow's box holds pink
 *    pixels in some frames and a different count in others (it animates), and none with the animals hidden.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startStack, enterBattle, standStill, selectWeapon, tally, sleep, freePort, drawnFrames, root } from './harness.mjs'
import { photo, comparePhotos } from './pixels.mjs'

const { fail, ok, finish } = tally('durian')
const rs = readFileSync(join(root, 'crates/game-core/src/constants.rs'), 'utf8')
const num = (name) => {
  const m = new RegExp(`^pub const ${name}: [a-z0-9]+ = ([0-9.]+);`, 'm').exec(rs)
  if (!m) throw new Error(`constants.rs has no \`${name}\``)
  return Number(m[1])
}
const DURIAN_TREES = num('DURIAN_TREES')
const DURIAN_FRUIT = num('DURIAN_FRUIT')
const DURIAN_PIECES = num('DURIAN_PIECES')
const DURIAN_GAS_RADIUS = num('DURIAN_GAS_RADIUS')
const DURIAN_TREE_W = num('DURIAN_TREE_W')
const DURIAN_TREE_H = num('DURIAN_TREE_H')

/** A classic Small map that grows two trees (`map::durian`): seed 7, trees at (1824, 533) and (480, 666). */
const SEED = 7
/** The share of the tree's screen box its drawing must change (ink over sky and rock, rim-lit). */
const TREE_MIN = 0.08
/** A point counts as painted past this per-channel change. */
const VISIBLE = 12
const RING = 12

const stack = await startStack({
  port: await freePort(),
  label: 'durian',
  env: { ROUND_SECONDS: '240', BOT_COUNT: '0', DEV_DURIAN: '1', FIXED_SEED: String(SEED), WEATHER: 'off' },
})
const { page, dbg, shot } = await stack.openClient({ name: 'ana' })
try {
  await enterBattle(page, { waitPlaying: true, label: 'durian' })
  await page.waitForFunction(() => window.__world?.litTerrain?.()?.drawn, null, { timeout: 120_000 })
  const freeze = (on) => page.evaluate((v) => window.__game.freeze(v), on)
  const frame = () => drawnFrames(page, 2)

  // ------------------------------------------------------------------ 1. both ends
  const trees = (await dbg()).durianTrees ?? []
  await page.waitForFunction((n) => (window.__game.debug().drawnItems ?? []).filter((i) => i.source === 'Tree').length >= n, trees.length * DURIAN_FRUIT, { timeout: 10_000 }).catch(() => null)
  const fruit = ((await dbg()).drawnItems ?? []).filter((i) => i.source === 'Tree')
  console.log(`  1. ${trees.length} tree(s) ${JSON.stringify(trees)}; ${fruit.length} fruit hanging`)
  if (!(trees.length >= 1 && trees.length <= DURIAN_TREES)) fail(`map_init carried ${trees.length} trees (want 1–${DURIAN_TREES} on seed ${SEED})`)
  else ok(`map_init carried ${trees.length} durian tree(s)`)
  if (fruit.length !== trees.length * DURIAN_FRUIT) fail(`${fruit.length} fruit hang on ${trees.length} trees — want ${DURIAN_FRUIT} each`)
  else ok(`the server grew ${DURIAN_FRUIT} fruit on each tree (${fruit.length})`)
  const under = (f) => trees.some((t) => Math.abs(f.x - t.x) <= DURIAN_TREE_W / 2 && f.y < t.y && f.y > t.y - DURIAN_TREE_H)
  if (!fruit.every(under)) fail(`a fruit hangs outside every canopy: ${JSON.stringify(fruit)}`)

  if (trees.length) {
    // ---------------------------------------------------------------- 2. the tree in the picture
    const t = trees[0]
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [t.x, t.y - DURIAN_TREE_H / 2])
    await sleep(600)
    await freeze(true)
    await frame()
    const d = await dbg()
    const toS = (x, y) => ({ x: (x - d.worldView.x) * d.zoom, y: (y - d.worldView.y) * d.zoom })
    const a = toS(t.x - DURIAN_TREE_W / 2, t.y - DURIAN_TREE_H)
    const box = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(DURIAN_TREE_W * d.zoom), h: Math.round(DURIAN_TREE_H * d.zoom) }
    const beside = { x: box.x + box.w + 120 > 1180 ? Math.max(0, box.x - box.w - 120) : box.x + box.w + 120, y: box.y, w: Math.min(100, box.w), h: box.h }
    const on = await photo(page)
    await shot('durian-tree')
    await page.evaluate(() => window.__game.setDurianTreesVisible(false))
    await frame()
    const off = await photo(page)
    const off2 = await photo(page)
    await page.evaluate(() => window.__game.setDurianTreesVisible(true))
    await frame()
    const inBox = await comparePhotos(page, on, off, { rect: box })
    const nextTo = await comparePhotos(page, on, off, { rect: beside })
    const idle = await comparePhotos(page, off, off2)
    console.log(`  2. tree box ${JSON.stringify(box)}: ${(inBox.fraction * 100).toFixed(1)} % changed (min ${TREE_MIN * 100} %); beside ${(nextTo.fraction * 100).toFixed(2)} %; off twice ${(idle.fraction * 100).toFixed(2)} %`)
    if (idle.fraction !== 0) fail(`control: the frame with the trees off drawn twice differs (${idle.fraction}) — the clock is not held`)
    if (nextTo.fraction !== 0) fail(`control: switching the trees off changed the box beside the tree (${nextTo.fraction})`)
    if (!(inBox.fraction >= TREE_MIN)) fail(`the tree is not in the picture: ${(inBox.fraction * 100).toFixed(1)} % of its box changed`)
    else ok(`the tree is drawn: ${(inBox.fraction * 100).toFixed(1)} % of its box`)

    // ---------------------------------------------------------------- 3. the fruit glow green
    const mine = fruit.filter((f) => Math.abs(f.x - t.x) <= DURIAN_TREE_W / 2)
    const ring = mine.flatMap((f) => {
      const c = toS(f.x, f.y)
      return Array.from({ length: RING }, (_, i) => ({ x: c.x + Math.cos((i / RING) * 6.283) * 10 * d.zoom, y: c.y + Math.sin((i / RING) * 6.283) * 10 * d.zoom }))
    })
    await page.evaluate(() => window.__game.setItemsVisible(false))
    await frame()
    const bare = await photo(page)
    const bare2 = await photo(page)
    await page.evaluate(() => window.__game.setItemsVisible(true))
    await frame()
    const lit = await photo(page)
    await page.evaluate(() => window.__game.freeze(false))
    const glow = await comparePhotos(page, lit, bare, { points: ring, thr: VISIBLE })
    const quiet = await comparePhotos(page, bare, bare2, { points: ring, thr: VISIBLE })
    const painted = glow.points.filter(Boolean).length
    const greener = glow.detail.filter((p) => p.a[1] - p.a[0] > p.b[1] - p.b[0]).length
    console.log(`  3. ${painted}/${ring.length} points round ${mine.length} fruit painted, ${greener} greener than bare`)
    if (quiet.points.some(Boolean)) fail('control: the frame without pickups drawn twice differs round the fruit')
    if (!(painted >= ring.length / 2)) fail(`the fruit's glow is not in the picture: ${painted}/${ring.length} points painted`)
    else if (!(greener >= ring.length / 2)) fail(`the fruit's glow is not green: ${greener}/${ring.length} points greener`)
    else ok(`the fruit glow green (${painted}/${ring.length} painted, ${greener} greener)`)
    await page.evaluate(() => window.__game.watch(null))
  }

  // ------------------------------------------------------------------ 4. the grenade
  await selectWeapon(page, 'durian_grenade')
  await standStill(page)
  const aim = await page.evaluate(() => {
    const d = window.__game.debug()
    const v = d.worldView
    const cv = document.querySelector('canvas').getBoundingClientRect()
    const wx = d.player.x + 100
    const wy = d.player.y - 173
    return { x: cv.left + ((wx - v.x) / v.width) * cv.width, y: cv.top + ((wy - v.y) / v.height) * cv.height }
  })
  await page.mouse.move(aim.x, aim.y)
  await sleep(150)
  await page.evaluate(() => window.__game.holdHazards(true))
  // Count the pieces as they fly: distinct ids of the drawn projectiles of kind `durianPiece`.
  await page.evaluate(() => {
    window.__pieces = new Set()
    const tick = () => {
      const st = window.__world.fxFeed()?.ordnance?.state
      for (const [id, p] of st?.projectiles ?? []) if (p.kind === 'durianPiece') window.__pieces.add(id)
      window.__piecesRaf = requestAnimationFrame(tick)
    }
    tick()
  })
  await page.evaluate(() => window.__game.fire())
  await page.waitForFunction((n) => [...(window.__world.fxFeed()?.zones?.state.hazards.values() ?? [])].filter((h) => h.kind === 'durian').length >= n, DURIAN_PIECES, { timeout: 8_000 }).catch(() => null)
  await sleep(200)
  const pieces = await page.evaluate(() => { cancelAnimationFrame(window.__piecesRaf); return window.__pieces.size })
  const clouds = await page.evaluate(() => [...(window.__world.fxFeed()?.zones?.state.hazards.values() ?? [])].filter((h) => h.kind === 'durian').map((h) => ({ x: h.x, y: h.y, r: h.r })))
  console.log(`  4. ${pieces} pieces drawn, ${clouds.length} purple clouds held ${JSON.stringify(clouds)}`)
  if (pieces !== DURIAN_PIECES) fail(`${pieces} durian pieces drawn — want ${DURIAN_PIECES}`)
  else ok(`the grenade burst into ${pieces} pieces`)
  if (clouds.length !== DURIAN_PIECES) fail(`${clouds.length} purple clouds held — want ${DURIAN_PIECES}`)
  else ok(`${clouds.length} purple clouds, each radius ${clouds[0]?.r} (DURIAN_GAS_RADIUS ${DURIAN_GAS_RADIUS})`)
  if (clouds.length) {
    await freeze(true)
    await frame()
    const d = await dbg()
    const pts = clouds.flatMap((c) => Array.from({ length: RING }, (_, i) => ({ x: (c.x - d.worldView.x) * d.zoom + Math.cos((i / RING) * 6.283) * c.r * 0.5 * d.zoom, y: (c.y - d.worldView.y) * d.zoom + Math.sin((i / RING) * 6.283) * c.r * 0.5 * d.zoom }))).filter((p) => p.x > 2 && p.x < 1278 && p.y > 2 && p.y < 718)
    const drawn = await photo(page)
    await shot('durian-gas')
    await page.evaluate(() => window.__world.hideLayers(['fx']))
    await frame()
    const hidden = await photo(page)
    const hidden2 = await photo(page)
    await page.evaluate(() => window.__world.hideLayers([]))
    const gas = await comparePhotos(page, drawn, hidden, { points: pts, thr: VISIBLE })
    const still = await comparePhotos(page, hidden, hidden2, { points: pts, thr: VISIBLE })
    const n = gas.points.filter(Boolean).length
    const purple = gas.detail.filter((p, i) => gas.points[i] && p.a[2] > p.a[1] && p.a[0] > p.a[1]).length
    console.log(`  4. ${n}/${pts.length} cloud points painted, ${purple} of them purple`)
    if (still.points.some(Boolean)) fail('control: the frame with the effects hidden drawn twice differs in the clouds')
    if (!(pts.length >= RING && n >= pts.length / 2)) fail(`the purple clouds are not in the picture: ${n}/${pts.length} points painted`)
    else if (!(purple >= n / 2)) fail(`the clouds are not purple: ${purple}/${n} painted points`)
    else ok(`the clouds are drawn and purple (${n}/${pts.length} painted, ${purple} purple)`)
    await freeze(false)
  }

  // ------------------------------------------------------------------ 5. the alien cow
  const cows = await page.evaluate(() => window.__game.cows())
  console.log(`  5. ${cows.length} cow(s) ${JSON.stringify(cows)}`)
  if (cows.length !== trees.length) fail(`${cows.length} cows drawn by ${trees.length} trees — want one a tree`)
  else ok(`a cow by each tree (${cows.length})`)
  // Beside its tree, fully in view (the owner): the cow's drawing — tail 24 px behind its middle, spiked head 36 ahead —
  // clear of every tree's box (`DURIAN_TREE_W` wide), yet within the leash of one.
  const COW_CLEAR = num('COW_CLEAR')
  const COW_LEASH = num('COW_LEASH')
  for (const c of cows) {
    const [x0, x1] = c.right ? [c.x - 24, c.x + 36] : [c.x - 36, c.x + 24]
    const under = trees.filter((t) => x1 > t.x - DURIAN_TREE_W / 2 && x0 < t.x + DURIAN_TREE_W / 2)
    const near = trees.some((t) => Math.abs(c.x - t.x) <= COW_LEASH + 1)
    console.log(`  5. cow ${c.id} drawn x ${x0.toFixed(0)}–${x1.toFixed(0)}; trees it overlaps ${under.length}; within the leash of one: ${near}`)
    if (under.length) fail(`cow ${c.id} stands under a tree (drawn ${x0.toFixed(0)}–${x1.toFixed(0)}) — not fully visible`)
    if (!near) fail(`cow ${c.id} is not by any tree (${COW_CLEAR}–${COW_LEASH} px)`)
  }
  // The cow framed is one that faces a canopy within its tongue's reach (`cows().reaches`): one beside a pillar,
  // facing away mid-amble, is a cow and not a failure; none able to reach on the whole map would be.
  await page.waitForFunction(() => window.__game.cows().some((c) => c.reaches), null, { timeout: 15_000 }).catch(() => null)
  const reacher = (await page.evaluate(() => window.__game.cows())).find((c) => c.reaches)
  if (!reacher) fail(`no cow faces a canopy within its tongue's reach: ${JSON.stringify(await page.evaluate(() => window.__game.cows()))}`)
  if (reacher) {
    const c0 = reacher
    await page.evaluate(([x, y]) => window.__game.watch(x, y), [c0.x, c0.y - 40])
    await page.evaluate(() => { window.__world.hideLayers(['leaves']); window.__game.setItemsVisible(false) })
    await sleep(800)
    // Pink: the tongue's #ff6fa8 through the grade — red high, green well under it, blue between.
    const pinkIn = (shot64, box) => page.evaluate(async ([src, b]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${src}`
      await img.decode()
      const cv = document.createElement('canvas')
      cv.width = img.width
      cv.height = img.height
      const g = cv.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(b.x, b.y, b.w, b.h).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i] - d[i + 1] > 70 && d[i + 2] - d[i + 1] > 20) n++
      return n
    }, [shot64, box])
    const counts = []
    let cowBox = null
    for (let k = 0; k < 24; k++) {
      const d = await dbg()
      const c = (await page.evaluate(() => window.__game.cows())).find((x) => x.id === c0.id) ?? c0
      const cx = (c.x - d.worldView.x) * d.zoom
      const cy = (c.y - d.worldView.y) * d.zoom
      cowBox = { x: Math.max(0, Math.round(cx - 240)), y: Math.max(0, Math.round(cy - 250)), w: 480, h: 270 }
      counts.push(await pinkIn(await photo(page), cowBox))
      await sleep(250)
    }
    await shot('durian-cow')
    await freeze(true)
    await frame()
    const withCow = await photo(page)
    await page.evaluate(() => window.__game.setAnimalsVisible(false))
    await frame()
    const noCow = await photo(page)
    const noCow2 = await photo(page)
    await page.evaluate(() => window.__game.setAnimalsVisible(true))
    await freeze(false)
    const drawnCow = await comparePhotos(page, withCow, noCow, { rect: cowBox })
    const idleCow = await comparePhotos(page, noCow, noCow2)
    const pinkHidden = await pinkIn(noCow, cowBox)
    console.log(`  5. cow box ${JSON.stringify(cowBox)}: ${(drawnCow.fraction * 100).toFixed(1)} % drawn; pink px over ${counts.length} frames ${JSON.stringify(counts)}; with the animals hidden ${pinkHidden}`)
    if (idleCow.fraction !== 0) fail('control: the frame with the animals hidden drawn twice differs')
    if (!(drawnCow.fraction > 0.01)) fail(`the cow is not in the picture (${(drawnCow.fraction * 100).toFixed(2)} % of its box)`)
    else ok(`the cow is drawn (${(drawnCow.fraction * 100).toFixed(1)} % of its box)`)
    if (pinkHidden !== 0) fail(`control: ${pinkHidden} pink px with the animals hidden — the pink test reads something else`)
    if (!(Math.max(...counts) >= 8)) fail(`no tongue: the grazing cow's box never held pink (${JSON.stringify(counts)})`)
    else if (new Set(counts).size < 2) fail(`the tongue does not move: ${JSON.stringify(counts)}`)
    else ok(`the cow reaches its tongue, and it moves (pink ${Math.min(...counts)}–${Math.max(...counts)} px)`)
    await page.evaluate(() => { window.__world.hideLayers([]); window.__game.setItemsVisible(true); window.__game.watch(null) })
  }
} catch (e) {
  fail(`the check stopped: ${e.message}`)
} finally {
  await stack.close()
}
finish()
