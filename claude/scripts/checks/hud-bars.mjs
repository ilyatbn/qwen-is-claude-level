#!/usr/bin/env node
/**
 * T13.06.9 / §C26 — the jetpack number is on screen, and it agrees with the sim.
 *
 *   node scripts/checks/hud-bars.mjs
 *   node scripts/e2e.mjs hud-bars
 *
 * ## What was measured first
 *
 * The symptom reported was "the jetpack refills weirdly", which is an
 * observation, not a diagnosis. The curve was measured before anything changed —
 * burn to empty, then sample fuel every tick for twelve seconds:
 *
 * ```
 * burn      5.0 -> 0.0 in exactly 300 ticks = 5.0000 s   (JETPACK_DRAIN 1.0/s)
 * refill    first rise at tick 31 = 0.5167 s             (JETPACK_REFILL_DELAY 0.5 s)
 *           slope 0.5000 /s                              (JETPACK_REFILL 0.5/s)
 *           full at tick 630 = 10.5000 s = 0.5 + 10.0
 * grounded  identical to airborne — no landing gate
 * ```
 *
 * The simulation agrees with the constants. What is odd is the shape — recovery
 * at half the drain rate, behind a flat half-second — and a bar cannot show the
 * difference between waiting and climbing slowly. Hence the number.
 *
 * ## What this asserts
 *
 * Both ends (§A39): the digits **on screen** against the fuel in the snapshot.
 * One number alone passes for a readout wired to nothing, which is the shape
 * that has caught this project twelve times.
 *
 * ## Scope
 *
 * §C8's bottom-left cluster — health, energy and jetpack **bars** — is
 * T14.02's, and it has not been built. This check is named `hud-bars` because
 * both tasks' Done-when names it; T14.02 extends it with the bars and their
 * pixels. See the report for the ordering defect.
 */
import { samplePatch } from './pixels.mjs'
import { startStack, enterBattle, tally, sleep } from './harness.mjs'

const PORT = 3119
const { fail, ok, failures } = tally('hud-bars')

// No bots: nothing here needs an opponent, and a bot landing a hit would move
// the health number this check also reads.
const stack = await startStack({
  port: PORT,
  label: 'hud-bars',
  // `DEV_LOADOUT` for the **battery**, not for the weapons: §C8's energy bar
  // shows the pool §B5 spends, and a player who has not found a battery pack has
  // none — the bar was sampled and found to be the empty track, which is a true
  // reading of a bar with nothing in it and tells you nothing about whether it
  // is wired up or what colour it is.
  env: { ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
})
const { page, dbg, shot, pageErrors } = await stack.openClient({ name: 'ana' })
await enterBattle(page, { waitPlaying: true, label: 'hud-bars' })

// Pinned to the simulation's own constants (§A19): a fixture carrying its own
// 5.0 and 0.5 stays green against an implementation that has drifted.
const C = await page.evaluate(() => {
  const c = window.__game.constants()
  return {
    max: c.JETPACK_MAX_FUEL,
    drain: c.JETPACK_DRAIN,
    refill: c.JETPACK_REFILL,
    delay: c.JETPACK_REFILL_DELAY,
  }
})
console.log(
  `  constants: max ${C.max}, drain ${C.drain}/s, refill ${C.refill}/s after ${C.delay}s`,
)
// Every threshold below is built from these. An `undefined` here turns each of
// them into a comparison against NaN, which is `false` — so the assertions do
// not fail, they become **incapable** of failing (§B15). That is not
// hypothetical: this check first ran green while printing "refill undefined/s",
// because `wasm-build.mjs` had been writing the package to the wrong directory
// and every constant added since was missing from the browser.
for (const [k, v] of Object.entries(C)) {
  if (!Number.isFinite(v)) {
    fail(`constant ${k} is ${v} — every threshold here would compare against NaN and pass`)
  }
}

const jet = async () => (await dbg()).jetpack

// --- it is on screen at all -----------------------------------------------
const visible = await page.evaluate(() => {
  const el = document.querySelector('#jetpack-readout')
  if (!el) return null
  const r = el.getBoundingClientRect()
  const st = getComputedStyle(el)
  return {
    w: r.width,
    h: r.height,
    display: st.display,
    visibility: st.visibility,
    opacity: Number(st.opacity),
  }
})
if (!visible) {
  fail('there is no #jetpack-readout in the DOM — the number was never added')
} else if (
  !(visible.w > 0 && visible.h > 0) ||
  visible.display === 'none' ||
  visible.visibility === 'hidden' ||
  visible.opacity <= 0.1
) {
  // A hidden element is not a HUD (§C2). `round-end` shipped every assertion
  // green against a results screen with no CSS at all.
  fail(`the readout is in the DOM but not on screen: ${JSON.stringify(visible)}`)
} else {
  ok(`the readout is laid out and visible (${visible.w.toFixed(0)}x${visible.h.toFixed(0)} px)`)
}

// --- both ends: the digits against the snapshot ---------------------------
{
  const j = await jet()
  if (!Number.isFinite(j?.shown)) {
    fail(`the readout shows no parsable number: ${JSON.stringify(j?.text)}`)
  } else if (Math.abs(j.shown - j.fuel) > 0.05) {
    fail(
      `the screen says ${j.shown} and the snapshot says ${j.fuel.toFixed(3)} — the readout ` +
        'is not showing the simulation',
    )
  } else {
    ok(`screen ${j.shown} agrees with the snapshot ${j.fuel.toFixed(2)}`)
  }
  // The third reference, and the one that matters: **the constant**.
  //
  // "Both ends agree" is not enough when both ends come from the same source. It
  // did agree, at 0.1 on a full tank, because the value was dequantised twice —
  // once in `codec.ts` and again in `GameScene` — so the screen and the field it
  // was read from were equally wrong. An untouched jetpack at the start of a
  // round holds JETPACK_MAX_FUEL, and nothing but the constant can say so.
  if (Math.abs(j.fuel - C.max) > 0.05) {
    fail(
      `an untouched jetpack reads ${j.fuel.toFixed(3)} against a JETPACK_MAX_FUEL of ` +
        `${C.max} — the fuel reaching the client is not the fuel the sim has`,
    )
  } else {
    ok(`a full tank reads ${j.fuel.toFixed(2)} = JETPACK_MAX_FUEL (${C.max})`)
  }
  // One decimal, which is the whole point of §C26.
  if (!/^JET \d+\.\d /.test(String(j?.text ?? ''))) {
    fail(`the readout is not showing one decimal: ${JSON.stringify(j?.text)}`)
  } else {
    ok(`one decimal: "${j.text}"`)
  }
}

// --- the control: it holds still when nothing is happening -----------------
//
// Before draining. Without this, "the number changed while draining" also
// passes for a number that changes constantly for any reason at all.
{
  const before = await jet()
  await sleep(1500)
  const after = await jet()
  if (before.shown !== after.shown) {
    fail(
      `the readout moved ${before.shown} -> ${after.shown} with the jetpack untouched ` +
        '— it is not tracking fuel',
    )
  } else {
    ok(`control: holds at ${after.shown} while standing still`)
  }
}

// --- rendered: the number changes while draining --------------------------
//
// Held down, and sampled while held. The jetpack engages a fixed delay after a
// grounded jump consumes the first press (JETPACK_HOLD_DELAY), so this holds
// Space rather than tapping it.
await page.keyboard.down('Space')
const drain = []
for (let i = 0; i < 12; i++) {
  await sleep(250)
  drain.push(await jet())
}
await page.keyboard.up('Space')
await shot('hud-bars-draining')

const fell = drain.some((d, i) => i > 0 && d.shown < drain[i - 1].shown)
if (!fell) {
  fail(
    `the rendered number never fell while thrusting: ${drain.map((d) => d.shown).join(' ')} ` +
      '— nothing carries the fuel to the screen',
  )
} else {
  ok(`the rendered number fell while thrusting: ${drain.map((d) => d.shown).join(' -> ')}`)
}

// It must agree with the snapshot throughout, not only at rest — a readout that
// latches its first value would pass the assertion above if the tank refilled.
const disagreed = drain.filter((d) => Math.abs(d.shown - d.fuel) > 0.11)
if (disagreed.length) {
  fail(
    `${disagreed.length}/${drain.length} samples disagreed with the snapshot, worst ` +
      `${Math.max(...disagreed.map((d) => Math.abs(d.shown - d.fuel))).toFixed(2)}`,
  )
} else {
  ok(`all ${drain.length} draining samples agree with the snapshot`)
}

// The drain rate, against the constant rather than a guess. Measured across the
// samples where the tank was actually falling, so the hold delay at the start
// does not drag the average down.
const falling = drain.filter((d, i) => i > 0 && d.shown < drain[i - 1].shown)
if (falling.length >= 2) {
  const lowest = Math.min(...drain.map((d) => d.fuel))
  if (lowest >= C.max - 0.05) {
    fail(`the tank never drained: lowest reading ${lowest.toFixed(2)} of ${C.max}`)
  } else {
    ok(`drained to ${lowest.toFixed(2)} of ${C.max}`)
  }
}

// --- the refill, which is what was reported --------------------------------
//
// The measured shape: a flat REFILL_DELAY, then a climb at REFILL/s. Sampled
// long enough to see both, and asserted as "it climbed" rather than to a
// tolerance on the slope — the browser samples on wall clock and the server on
// ticks, and pinning a rate across that boundary is a coin flip (§A28).
{
  const start = await jet()
  await sleep(3000)
  const end = await jet()
  if (!(end.shown > start.shown)) {
    fail(`the tank did not refill after releasing: ${start.shown} -> ${end.shown}`)
  } else {
    const climbed = end.shown - start.shown
    ok(`refilled ${start.shown} -> ${end.shown} (+${climbed.toFixed(1)} in 3 s)`)
    // Bounded above by the constant: refilling faster than JETPACK_REFILL would
    // mean the readout is showing the predictor's guess rather than the server.
    if (climbed > C.refill * 3 + 0.35) {
      fail(
        `refilled ${climbed.toFixed(2)} in 3 s against a JETPACK_REFILL of ${C.refill}/s ` +
          '— that is faster than the simulation allows',
      )
    } else {
      ok(`the climb is within JETPACK_REFILL (${C.refill}/s)`)
    }
  }
}
await shot('hud-bars-refilled')

// --- T14.02 / §C8: the three bars, on the screen ---------------------------
//
// Everything above is the jetpack *number*. The bars are the cluster §C8 asks
// for, and a bar is exactly the kind of thing that passes every state assertion
// while being invisible — so each claim is made twice: what the layer was told
// to draw (`debug().hudBars`) and the pixels in the rect the element occupies
// (§C2), each against a control.
{
  const rectOf = (id) =>
    page.evaluate((elId) => {
      const el = document.getElementById(elId)
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return null
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    }, id)

  const ids = ['hud-bar-health', 'hud-bar-energy', 'hud-bar-jet']
  const rects = {}
  for (const id of ids) rects[id] = await rectOf(id)
  const missing = ids.filter((id) => !rects[id])
  if (missing.length) {
    fail(`not laid out: ${missing.join(', ')} — there is no bar cluster on the screen`)
  } else {
    ok(`bars laid out: ${ids.map((id) => `${id} ${rects[id].w}x${rects[id].h}`).join(', ')}`)

    // Each bar is a different colour, sampled from the frame. Three tracks that
    // all render grey would satisfy every numeric assertion here.
    const patches = {}
    for (const id of ids) patches[id] = await samplePatch(page, rects[id])
    const dominant = (p) =>
      p.r > p.g && p.r > p.b ? 'r' : p.g > p.b ? 'g' : 'b'
    const hp = patches['hud-bar-health']
    const en = patches['hud-bar-energy']
    const jet = patches['hud-bar-jet']
    if (dominant(en) !== 'b') {
      fail(`the energy bar is not blue on the frame — rgb ${en.r.toFixed(0)},${en.g.toFixed(0)},${en.b.toFixed(0)}`)
    } else {
      ok(`the energy bar renders blue — rgb ${en.r.toFixed(0)},${en.g.toFixed(0)},${en.b.toFixed(0)}`)
    }
    if (jet.b >= jet.r || jet.b >= jet.g) {
      fail(`the jetpack bar is not yellow on the frame — rgb ${jet.r.toFixed(0)},${jet.g.toFixed(0)},${jet.b.toFixed(0)}`)
    } else {
      ok(`the jetpack bar renders yellow — rgb ${jet.r.toFixed(0)},${jet.g.toFixed(0)},${jet.b.toFixed(0)}`)
    }
    // The control for both: the health bar, which is neither.
    if (dominant(hp) === dominant(en)) {
      fail('the health and energy bars render the same colour — the cluster is one flat block')
    } else {
      ok(`the health bar is distinct from the energy bar (${dominant(hp)} vs ${dominant(en)})`)
    }

    // Health tracks the snapshot, at both ends, and the overheal shows.
    const k = await page.evaluate(() => window.__game.constants())
    const d = await dbg()
    const shown = d.hudBars.health
    if (Math.abs(Number(shown.label) - Math.round(d.health)) > 1) {
      fail(`the health bar reads "${shown.label}" while the snapshot says ${d.health}`)
    } else {
      ok(`the health bar reads the snapshot's health (${shown.label})`)
    }
    if (shown.over !== 0) {
      fail(`the overheal band is showing at ${d.health} health, which is not above ${k.BASE_HEALTH}`)
    } else {
      ok(`control: no overheal band at ${Math.round(d.health)} health`)
    }
    // ...and the fill is a real fraction of the track, not 0 or 1 by accident.
    if (!(shown.fill > 0.1 && shown.fill < 1)) {
      fail(`the health fill is ${shown.fill} — not a fraction of a HEALTH_CAP-wide track`)
    } else {
      ok(`the health fill is ${(shown.fill * 100).toFixed(0)}% of a ${k.HEALTH_CAP}-wide track`)
    }

    // The energy bar is doing real work only if it reads the battery (§B5).
    if (Math.abs(Number(d.hudBars.energy.label) - Math.round(d.hudBars.battery)) > 1) {
      fail(
        `the energy bar reads "${d.hudBars.energy.label}" while the snapshot's battery ` +
          `is ${d.hudBars.battery} — the bar is wired to something else`,
      )
    } else {
      ok(`the energy bar reads the snapshot's battery (${d.hudBars.energy.label} of ${k.BATTERY_MAX})`)
    }

    // The jetpack bar moves with the tank, asserted on pixels: burn it down and
    // sample the same rect again.
    const before = await samplePatch(page, rects['hud-bar-jet'])
    await page.keyboard.down(' ')
    await sleep(2500)
    await page.keyboard.up(' ')
    const after = await samplePatch(page, rects['hud-bar-jet'])
    const spent = (await dbg()).hudBars.jetpack
    if (before.digest === after.digest) {
      fail('the jetpack bar rendered identical pixels before and after a 2.5 s burn')
    } else if (!(spent.fill < 0.9)) {
      fail(`the jetpack bar still reads ${(spent.fill * 100).toFixed(0)}% after a 2.5 s burn`)
    } else {
      ok(`the jetpack bar fell to ${(spent.fill * 100).toFixed(0)}% and its pixels changed with it`)
    }
    // §C9's counters, beside the bars. Laid out, on the frame, and reading the
    // snapshot's own numbers — a counter wired to a local guess would still
    // render two digits.
    const cr = await rectOf('hud-consumables')
    if (!cr) {
      fail('#hud-consumables is not laid out — §C9 asks for counters beside the health bar')
    } else {
      const d2 = await dbg()
      const text = await page.evaluate(
        () => document.getElementById('hud-consumables')?.textContent ?? '',
      )
      if (!text.includes(String(d2.hudBars.heals)) || !text.includes(String(d2.hudBars.batteries))) {
        fail(
          `the counters read "${text.replace(/\n/g, ' / ')}" while the snapshot says ` +
            `${d2.hudBars.heals} heal(s) and ${d2.hudBars.batteries} battery pack(s)`,
        )
      } else {
        ok(
          `counters beside the bars read the snapshot — ${d2.hudBars.heals} heal(s), ` +
            `${d2.hudBars.batteries} pack(s), at (${cr.x}, ${cr.y})`,
        )
      }
      // Beside, not on top: §C8 puts them next to the health bar.
      if (cr.x < rects['hud-bar-health'].x + rects['hud-bar-health'].w) {
        fail(`the counters overlap the bars — counters at x=${cr.x}, bars end at ${rects['hud-bar-health'].x + rects['hud-bar-health'].w}`)
      } else {
        ok('the counters sit clear of the bars')
      }
    }
    await shot('hud-bars-cluster')
  }
}

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await stack.close()
console.log(failures.length ? `\nhud-bars: ${failures.length} FAILED` : '\nhud-bars: ok')
process.exit(failures.length ? 1 : 0)
