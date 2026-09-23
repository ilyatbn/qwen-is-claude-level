/**
 * T21.15 — two maps on different seeds must not wear the same rock.
 *
 * Reported from play: *"the map texture seems like it's always the same"*. It
 * was: `procTextures.ts` passed `makeNoiseTile` the literals 7, 23 and 41, so
 * the terrain tiles were byte-identical on every seed ever generated and the
 * only variation a player saw was which of three palettes the theme roll picked.
 *
 * ## Why the theme is pinned
 *
 * **Two arbitrary seeds usually roll different themes**, and a theme change
 * recolours the whole map — so "two maps look different" would pass with the
 * tiles still identical, measuring the palette and calling it the texture. Seeds
 * 0 and 1 both roll theme 0 (`map/meta.rs::theme_for`), so this varies exactly
 * one thing.
 *
 * The control region is the **UI panel**, which is screen-space and must not
 * move between two maps. Without it, "the terrain differs" is also what a
 * screenshot of a different camera position produces.
 */
import { samplePatch, assertChanged } from './pixels.mjs'

export default async function ({ page, shot, log }) {
  const frame = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })

  // A patch of solid terrain, well inside the frame and below the UI panel.
  const rock = {
    x: Math.round(frame.x + frame.w * 0.55),
    y: Math.round(frame.y + frame.h * 0.62),
    w: 120,
    h: 90,
  }
  // Screen-space UI: identical between two maps, whatever the terrain does.
  //
  // **The weather button row, not the panel header.** The header carries the
  // seed box and the readout line ("seed 4242 scale Medium theme 2"), both of
  // which legitimately change between two seeds — measured at 3.1, under the
  // threshold but not zero, and a control that moves for a reason of its own is
  // not holding anything still. These buttons are fixed labels.
  const ui = {
    x: Math.round(frame.x + 70),
    y: Math.round(frame.y + 168),
    w: 220,
    h: 46,
  }

  const look = async (seed) => {
    await page.evaluate((s) => window.__game.regenerate(s, 'medium'), String(seed))
    await page.waitForTimeout(900)
    // Freeze the sky and the cycle so nothing but the terrain can differ.
    await page.evaluate(() => {
      window.__game.setTime(0)
      window.__game.setParallaxClock(0)
    })
    await page.waitForTimeout(250)
    const theme = await page.evaluate(() => window.__game.core.meta.theme)
    return { theme, rock: await samplePatch(page, rock), ui: await samplePatch(page, ui) }
  }

  // Both roll theme 0, so the palette is held still and only the seed moves.
  const a = await look(0)
  await shot('terrain-seed-0')
  const b = await look(1)
  await shot('terrain-seed-1')

  if (a.theme !== b.theme) {
    throw new Error(
      `seeds 0 and 1 rolled themes ${a.theme} and ${b.theme} — the palette moved, ` +
        `so this would measure the theme rather than the texture`,
    )
  }
  log(`both maps are theme ${a.theme}, so only the seed differs`)

  // --- the assertion that actually isolates the texture -------------------
  //
  // **A rendered-pixel comparison of two maps cannot see this bug**, and that is
  // measured rather than assumed: with the seed argument dropped at the call
  // site — the original defect, in full — a terrain patch across seeds 0 and 1
  // still moved 44.1 against a control of 0.1. Two seeds generate different
  // *geometry*, so the frame differs whatever the tiles do. The pixel delta was
  // reporting "the map changed" while claiming "the texture changed".
  //
  // So the texture is pinned where it can be: the map's seed against the seed
  // the tiles were built from, counted at both ends. Dropping the argument makes
  // these disagree immediately. The per-pixel proof that a seed *changes* the
  // tile lives in `procTextures-math.test.ts`, which can reach the arithmetic
  // without a canvas.
  const seeds = await page.evaluate(() => window.__game.terrainSeeds())
  log(`map seed ${seeds.map}, tile seed ${seeds.tiles}`)
  if (seeds.tiles !== seeds.map) {
    throw new Error(
      `the terrain tiles were built from ${seeds.tiles} but the map is ${seeds.map} — ` +
        `the seed is not reaching procTextures (every map would wear the same rock)`,
    )
  }

  // And it tracks a regenerate rather than being captured once.
  await page.evaluate(() => window.__game.regenerate('777', 'medium'))
  await page.waitForTimeout(800)
  const after = await page.evaluate(() => window.__game.terrainSeeds())
  log(`after regenerate: map ${after.map}, tiles ${after.tiles}`)
  if (after.tiles !== after.map) {
    throw new Error(`after a regenerate the tiles used ${after.tiles} for map ${after.map}`)
  }
  if (after.tiles === seeds.tiles) {
    throw new Error(
      `a different map reused tile seed ${after.tiles} — the textures are not being rebuilt`,
    )
  }

  // The frames are kept for a human to look at; they are not the assertion.
  log('the terrain tiles are seeded by the map, and follow it across a regenerate')
}
