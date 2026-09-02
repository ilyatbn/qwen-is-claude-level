#!/usr/bin/env node
/**
 * T14.05 / §C10 — the quick bar, the backpack, and a drag that reaches the server.
 *
 *   node scripts/checks/inventory-ui.mjs
 *   node scripts/e2e.mjs inventory-ui
 *
 * ## What only a browser can answer
 *
 * `items::inventory::dragging` owns the rules and `game-server/tests/inventory.rs`
 * owns the command. Neither can tell you that the **tiles exist**, that
 * right-click reveals the backpack, or that a drop on a tile turns into a
 * `move_item` on the wire — and a panel wired to nothing passes every one of
 * those suites (§A15). So this asserts the DOM, the pixels, and the *server's*
 * inventory afterwards (§A39: both ends).
 */
import { samplePatch } from './pixels.mjs'
import { startStack, enterBattle, tally, sleep } from './harness.mjs'

const PORT = 3125
const { fail, ok, finish } = tally('inventory-ui')

const stack = await startStack({
  port: PORT,
  label: 'inventory-ui',
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'inventory-ui' })

const k = await page.evaluate(() => window.__game.constants())
const QUICK = k.QUICK_SLOTS
const TOTAL = k.INVENTORY_SLOTS
console.log(`  ${QUICK} quick slots, ${TOTAL} in total`)

const rectOf = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }, sel)

const tileCount = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel)

// --- the bar is there, always -----------------------------------------------
const bar = await rectOf('#inventory-bar')
if (!bar) {
  fail('#inventory-bar is not laid out — §C10 asks for an always-visible quick bar')
} else {
  const n = await tileCount('#inventory-bar > [data-slot]')
  if (n === QUICK) ok(`the quick bar shows ${n} tiles, at (${bar.x}, ${bar.y})`)
  else fail(`the quick bar shows ${n} tiles, not QUICK_SLOTS (${QUICK})`)

  // --- right-click reveals the backpack, and closes it again ---------------
  //
  // Asserted on the rendered rect, not on a style property: `display:grid` on an
  // element with no height is not a visible panel.
  const closed = await rectOf('#inventory-backpack')
  if (closed) fail('the backpack is showing before anything opened it')
  else ok('control: the backpack is down at the start')

  const centre = { x: 640, y: 360 }
  await page.mouse.click(centre.x, centre.y, { button: 'right' })
  await sleep(250)
  const opened = await rectOf('#inventory-backpack')
  if (!opened) {
    fail('right-click did not reveal the backpack')
  } else {
    const bn = await tileCount('#inventory-backpack > [data-slot]')
    ok(`right-click opened the backpack: ${bn} tiles, ${opened.w}x${opened.h} at (${opened.x}, ${opened.y})`)
    if (bn !== TOTAL - QUICK) fail(`the backpack shows ${bn} tiles, not BACKPACK_SLOTS (${TOTAL - QUICK})`)
    // Above the bar, which is where §C10 puts it.
    if (opened.y + opened.h > bar.y + 4) {
      fail(`the backpack (bottom ${opened.y + opened.h}) is not above the bar (top ${bar.y})`)
    } else {
      ok('and it sits above the quick bar')
    }
    await shot('inventory-open')
  }

  // --- the round keeps running behind it (§C10, §B4) -----------------------
  const t0 = await dbg()
  await sleep(700)
  const t1 = await dbg()
  if (t1.serverRoundTime > t0.serverRoundTime + 0.3) {
    ok(`the round ran on behind the panel (${t0.serverRoundTime.toFixed(1)}s → ${t1.serverRoundTime.toFixed(1)}s)`)
  } else {
    fail(
      `the world barely advanced with the panel open: ` +
        `${t0.serverRoundTime.toFixed(2)}s → ${t1.serverRoundTime.toFixed(2)}s`,
    )
  }

  // --- a drag, and the SERVER's inventory afterwards -----------------------
  //
  // Playwright's `dragAndDrop` drives the real HTML5 drag events, which is what
  // the tiles listen to. The assertion is on the server's answer: the tiles are
  // only ever rendered from an `inventory` event, so a client that moved them
  // itself would be showing a state the server does not have.
  const before = await dbg()
  const fromSlot = (before.slots ?? []).findIndex((s) => s.key && s.slot < QUICK)
  const toSlot = QUICK // the first backpack tile
  if (fromSlot < 0) {
    fail('the dev loadout put nothing in the quick bar, so there is nothing to drag')
  } else {
    const key = before.slots[fromSlot].key
    const emptyTarget = (before.slots ?? [])[toSlot]?.key === null
    if (!emptyTarget) fail('the first backpack slot is occupied, so this drag is a swap and not a move')

    await page.dragAndDrop(`[data-slot="${fromSlot}"]`, `[data-slot="${toSlot}"]`)
    await sleep(500)

    const after = await dbg()
    const nowThere = (after.slots ?? [])[toSlot]
    const nowGone = (after.slots ?? [])[fromSlot]
    if (nowThere?.key === key && nowGone?.key === null) {
      ok(`dragged "${key}" from quick slot ${fromSlot + 1} into the backpack, and the server agrees`)
    } else {
      fail(
        `the drag did not take: slot ${fromSlot + 1} holds ${nowGone?.key ?? 'nothing'} and ` +
          `backpack slot 1 holds ${nowThere?.key ?? 'nothing'}`,
      )
    }

    // The tile's own pixels changed with it — a server that agreed while the
    // panel drew the old arrangement is the §A15 shape all over again.
    const tile = await rectOf(`[data-slot="${toSlot}"]`)
    if (!tile) {
      fail('the backpack tile has no rect to sample')
    } else {
      const patch = await samplePatch(page, tile)
      const emptyTile = await rectOf(`[data-slot="${TOTAL - 1}"]`)
      const emptyPatch = emptyTile ? await samplePatch(page, emptyTile) : null
      if (emptyPatch && patch.digest !== emptyPatch.digest) {
        ok('the filled backpack tile renders differently from an empty one')
      } else {
        fail('the tile holding the dragged stack looks identical to an empty tile')
      }
    }
    await shot('inventory-dragged')
  }

  // --- the tile draws the item, not its name (T18.06, §E14) ----------------
//
// The digest comparison above passed before this task too, when a filled tile
// held a wrapped text label and an empty one held nothing. It says the tiles
// differ, not that either draws art. These assertions are about the art layer
// itself.
{
  const filled = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('[data-slot]')]
    const art = (t) => t.querySelector('[data-art]')
    const first = tiles.find((t) => t.dataset.filled === '1' && art(t)?.dataset.art === '1')
    const empty = tiles.find((t) => t.dataset.filled === '0')
    const rect = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return null
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    return {
      slot: first ? Number(first.dataset.slot) : null,
      url: first ? art(first).style.backgroundImage : '',
      text: first ? (first.querySelector('b')?.textContent ?? '') : '',
      artRect: rect(first && art(first)),
      emptyArtRect: rect(empty && art(empty)),
      emptyUrl: empty ? (art(empty)?.style.backgroundImage ?? '') : '',
    }
  })

  if (filled.slot === null) {
    // DEV_LOADOUT fills the bar, so no tile resolving art means the resolution
    // is broken, not that the loadout was empty. Failing rather than skipping:
    // a skip reported as `ok` is the D-29 shape.
    fail('no filled tile resolved any art — every tile fell back to its name')
  } else {
    const m = /^url\("data:image\/png;base64,([^"]+)"\)$/.exec(filled.url)
    if (!m) {
      fail(`slot ${filled.slot + 1} says it has art but its background is ${filled.url || '(empty)'}`)
    } else {
      // Not just "a URL is set": a 1x1 transparent PNG would satisfy that and
      // render nothing, which is the failure this whole task exists to fix.
      const bytes = Buffer.from(m[1], 'base64').length
      if (bytes > 100) ok(`slot ${filled.slot + 1} draws a ${bytes}-byte PNG, not its name`)
      else fail(`slot ${filled.slot + 1}'s art is ${bytes} bytes — too small to be an icon`)
    }

    // The control: an empty tile has no art. Without it, "the filled tile has a
    // background" passes for a panel that paints every tile the same.
    if (filled.emptyUrl === '') ok('control: an empty tile resolves no art at all')
    else fail(`an empty tile has a background image (${filled.emptyUrl})`)

    // The text is now the count, not the key — the picture says which item it
    // is. `x1` is deliberately absent, so a single item shows no text at all.
    if (!/[a-z]{3}/.test(filled.text)) {
      ok(`and its text is "${filled.text}", not the registry key`)
    } else {
      fail(`slot ${filled.slot + 1} still shows the key as text: "${filled.text}"`)
    }

    // Pixels, on the art layer itself and against an empty tile's art layer in
    // the same frame — docs/72 §C2. The digest, not the mean: a small icon
    // centred in a box moves few pixels and a mean can absorb it.
    if (!filled.artRect || !filled.emptyArtRect) {
      fail('the art layers have no rect to sample')
    } else {
      const a = await samplePatch(page, filled.artRect)
      const b = await samplePatch(page, filled.emptyArtRect)
      if (a.digest !== b.digest) {
        ok(`the art layer renders pixels an empty tile's does not (lum ${a.lum.toFixed(1)} vs ${b.lum.toFixed(1)})`)
      } else {
        fail('the filled tile\'s art layer is pixel-identical to an empty one')
      }
    }
  }
  await shot('inventory-art')
}

// --- and a backpack slot cannot be selected (§C10) -----------------------
  const selBefore = (await dbg()).selectedSlot
  await page.click(`[data-slot="${TOTAL - 1}"]`)
  await sleep(300)
  const selAfter = (await dbg()).selectedSlot
  if (selAfter === selBefore) {
    ok(`clicking a backpack tile did not move the selection (still slot ${selAfter + 1})`)
  } else {
    fail(`clicking a backpack tile moved the selection to ${selAfter + 1}`)
  }

  // --- right-click closes it again ----------------------------------------
  await page.mouse.click(centre.x, centre.y, { button: 'right' })
  await sleep(250)
  if (await rectOf('#inventory-backpack')) {
    fail('a second right-click did not close the backpack')
  } else {
    ok('a second right-click closes it')
  }
}

// --- §F4.1: the right button opens the backpack and fires NOTHING ----------
//
// The mouse mapping was specified as both-buttons-fire and then withdrawn, so
// this is the assertion that keeps the withdrawal honest. It matters more now
// than it did: §F3 added a per-frame repeat driven by a held button, and the
// obvious way to get that wrong is to read "a button" rather than "the left
// button" — which would turn every backpack browse into a burst of gunfire.
{
  const shots = async () => (await dbg()).observed?.projectileSpawns ?? 0
  const mid = { x: 640, y: 360 }
  // Aim away from the feet so the control shot below cannot kill her.
  await page.mouse.move(mid.x + 220, mid.y)
  await sleep(150)
  const before = await shots()
  await page.mouse.down({ button: 'right' })
  // Held for well over any weapon's cooldown: a repeat that keyed off the wrong
  // button would have fired several times by now.
  await sleep(1000)
  await page.mouse.up({ button: 'right' })
  await sleep(300)
  const after = await shots()
  if (after === before) {
    ok(`holding the right button for 1s fired nothing (${before} shots before and after)`)
  } else {
    fail(`holding the right button fired ${after - before} rounds — right-click opens the backpack (§F4.1)`)
  }

  // **The control.** "Right fires nothing" is satisfied by a client that fires
  // nothing at all — which is exactly what a broken repeat looks like — so the
  // left button must demonstrably still work from the same position.
  await page.mouse.down({ button: 'left' })
  await sleep(400)
  await page.mouse.up({ button: 'left' })
  await sleep(300)
  const afterLeft = await shots()
  if (afterLeft > after) {
    ok(`control: the left button from the same spot fired ${afterLeft - after}`)
  } else {
    fail('the left button fired nothing either — the right-button assertion above proves nothing')
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await finish(() => stack.close())
