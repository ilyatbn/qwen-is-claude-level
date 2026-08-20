/**
 * The M4 checkpoint, driven headlessly: pick up a bazooka, fire it, watch the
 * crater form, take self-damage, and open the inventory on right-click.
 */
export default async function ({ page, shot, log }) {
  const inv = () => page.evaluate(() => window.__game.inventory())
  const solid = () =>
    page.evaluate(() => {
      const v = window.__game.core.maskView()
      let n = 0
      for (let i = 0; i < v.length; i++) { let b = v[i]; while (b) { n += b & 1; b >>= 1 } }
      return n
    })

  await page.evaluate(() => window.__game.regenerate('12345', 'medium'))
  await page.waitForTimeout(500)

  const start = await inv()
  log(`inventory at start: ${start.slots.filter(Boolean).map((s) => `${s.key} x${s.count}`).join(', ')}`)
  if (!start.slots.some((s) => s && s.key === 'bazooka')) throw new Error('no bazooka')
  log(`health ${start.health}`)

  // Straight down, into the ground at my own feet: the rocket spawns MUZZLE_OFFSET
  // below centre, which is at or inside the floor, so it goes off well within its
  // own 42 px blast radius. This is the rocket-jump case.
  await page.mouse.move(640, 360 + 200)
  await page.waitForTimeout(200)

  const before = await solid()
  const ev = await page.evaluate(() => window.__game.fire())
  log(`fire -> ${JSON.stringify(ev).slice(0, 120)}`)
  if (ev.rejected) throw new Error(`fire rejected: ${ev.rejected}`)
  if (!ev.projectile) throw new Error('the bazooka spawned no projectile')

  // Let it fly and explode.
  await page.waitForTimeout(1200)
  const after = await solid()
  const now = await inv()
  log(`terrain solid ${before} -> ${after}  (crater removed ${before - after} px)`)
  log(`health ${start.health} -> ${now.health}`)
  await shot('m4-crater')

  if (!(after < before)) throw new Error('firing a bazooka carved nothing')
  if (!(before - after > 2000)) throw new Error(`crater too small: ${before - after} px`)
  if (!(now.health < start.health)) throw new Error('no self-damage from a rocket at my own feet')
  if (now.slots.find((s) => s && s.key === 'bazooka').count !== 3) {
    throw new Error('ammo was not consumed')
  }
  log('self-damage and ammo consumption both confirmed')

  // Right-click opens the inventory panel.
  const open = await page.evaluate(() => window.__game.toggleInventory())
  if (!open) throw new Error('the inventory did not open')
  await page.waitForTimeout(200)
  await shot('m4-inventory')
  log('inventory panel open')

  // SMG: a visible tracer, and it digs.
  await page.evaluate(() => window.__game.toggleInventory())
  await page.evaluate(() => window.__game.selectSlot(2))
  const beforeSmg = await solid()
  const smg = await page.evaluate(() => window.__game.fire())
  if (!smg.hitscan) throw new Error(`the smg did not produce a hitscan: ${JSON.stringify(smg)}`)
  const afterSmg = await solid()
  log(`smg: ${smg.hitscan.length} ray(s), ${smg.hitscan[0].hit}, dug ${beforeSmg - afterSmg} px`)
  const ord = await page.evaluate(() => window.__game.ordnance())
  log(`ordnance layer: ${JSON.stringify(ord)}`)
  if (ord.tracers < 1) throw new Error('the smg drew no tracer — every shot must be visible')
}
