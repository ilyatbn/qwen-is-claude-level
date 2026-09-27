/**
 * `terrain-seed` — T23.07B F2 (R24): the rock's pattern differs from map to map.
 *
 * T21.15's owner report — *every map wears the same rock* — came back with the lit terrain: its albedo
 * (`client/src/look/albedo.ts::ALBEDO_FS`, the mockup's `world.js::derive`) is a function of the world
 * position and the fields alone, so the same world px on two maps with the same fields painted the same
 * strata, boulders and cracks. R24 adds a per-map integer offset to the position the noise reads,
 * hashed from the map seed (`albedoOffset`; 0 in the look-lab).
 *
 * **The instrument: a deep-rock rect.** Where every px of a world rect is at least 64 px inside the rock
 * (`dIn` saturated: the fields' R byte 255) on both maps, the albedo's inputs there are identical — no
 * soil, grass, scorch or wall reaches it, and the "which way is up" gradient is 0 — so the only thing
 * that can make the two albedos differ is the offset. The rect is chosen from the fields of **both**
 * maps (`renderFieldsView`), read back from the GPU albedo (`__world.readAlbedo`).
 *
 * - **Two seeds differ**: at least `MIN_DIFFER` of the rect's px differ between seed A and seed B.
 * - **Control, the same seed twice is equal**: A regenerated again reads back byte-identical — so the
 *   difference is the seed's, not the paint's noise or a stale texture.
 * - **Control, the rect is rock**: every px of it is painted opaque rock (albedo A = 255) on both.
 *
 * Planted (`terrainFields.ts`: `albedoOffset` forced to `[0, 0]`): the two seeds read back equal — red.
 */

/** The two maps, V2 Medium: the sandbox's default seed and gate-ground's. */
const SEED_A = 4242
const SEED_B = 7
/** Side of the deep-rock rect, world px (a boulder cell is ~45 px across: several fit). */
const RECT = 64
/** Of the rect's px, at least this fraction must differ between the seeds (measured: see the journal). */
const MIN_DIFFER = 0.5

async function deepRockCells(page, seed) {
  await page.evaluate((s) => window.__game.regenerate(String(s)), seed)
  return page.evaluate((n) => {
    const c = window.__game.core
    const w = c.width
    const h = c.height
    const f = c.renderFieldsView()
    const out = []
    for (let cy = 0; cy + n <= h; cy += n) {
      for (let cx = 0; cx + n <= w; cx += n) {
        let deep = true
        for (let y = cy; y < cy + n && deep; y++) for (let x = cx; x < cx + n && deep; x++) deep = f[(y * w + x) * 4] === 255
        if (deep) out.push(`${cx},${cy}`)
      }
    }
    return out
  }, RECT)
}

async function albedoAt(page, seed, [x, y]) {
  await page.evaluate((s) => window.__game.regenerate(String(s)), seed)
  const info = await page.evaluate(() => window.__world.terrain())
  if (!info?.ready) throw new Error(`seed ${seed}: the lit terrain is not ready after the regenerate (${JSON.stringify(info)})`)
  const b64 = await page.evaluate(([x, y, n]) => window.__world.readAlbedo(x, y, n, n), [x, y, RECT])
  if (!b64) throw new Error(`seed ${seed}: no albedo to read back`)
  return Buffer.from(b64, 'base64')
}

export default async function ({ page, shot, log }) {
  const a = await deepRockCells(page, SEED_A)
  const b = new Set(await deepRockCells(page, SEED_B))
  const both = a.filter((k) => b.has(k))
  log(`deep-rock ${RECT}px cells: seed ${SEED_A} ${a.length}, seed ${SEED_B} ${b.size}, in both ${both.length}`)
  if (!both.length) throw new Error('no world rect is deep rock on both maps — pick other seeds')
  const at = both[Math.floor(both.length / 2)].split(',').map(Number)

  const pa = await albedoAt(page, SEED_A, at)
  const pb = await albedoAt(page, SEED_B, at)
  const pa2 = await albedoAt(page, SEED_A, at)
  await shot('terrain-seed')
  const n = RECT * RECT
  let differ = 0
  let same2 = 0
  let opaque = 0
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (pa[o] !== pb[o] || pa[o + 1] !== pb[o + 1] || pa[o + 2] !== pb[o + 2]) differ++
    if (pa[o] === pa2[o] && pa[o + 1] === pa2[o + 1] && pa[o + 2] === pa2[o + 2] && pa[o + 3] === pa2[o + 3]) same2++
    if (pa[o + 3] === 255 && pb[o + 3] === 255) opaque++
  }
  const offsets = await page.evaluate(() => window.__world.terrain()?.albedoOffset ?? null)
  log(
    `rect (${at[0]}, ${at[1]}) ${RECT}x${RECT}: seed ${SEED_A} vs ${SEED_B} ${differ}/${n} px differ (min ${Math.ceil(MIN_DIFFER * n)}); ` +
      `seed ${SEED_A} twice ${same2}/${n} equal; opaque rock on both ${opaque}/${n}; last map's offset ${JSON.stringify(offsets)}`,
  )
  const problems = []
  if (opaque !== n) problems.push(`control: the rect is not all opaque rock on both maps (${opaque}/${n})`)
  if (same2 !== n) problems.push(`control: seed ${SEED_A} painted twice differs on ${n - same2} px — the readback is not the seed's pattern`)
  if (differ < MIN_DIFFER * n) problems.push(`the same deep-rock rect wears the same rock on seeds ${SEED_A} and ${SEED_B}: only ${differ}/${n} px differ`)
  if (problems.length) throw new Error(`terrain-seed:\n  - ${problems.join('\n  - ')}`)
}
