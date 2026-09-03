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
  // **`FIXED_SEED` so the terrain is the same every run.** Nothing here is a
  // claim about maps — it reads bars, colours and numbers against the snapshot —
  // but where the player spawns decides whether it lands on a teleport pad, and
  // T15.01's pads fire after `TELEPORT_CHARGE` of standing still. Holding Space
  // jumps first, which arms the pad; this check then holds it, and the teleport
  // moved the subject of every assertion. That is how it found the refuelling
  // bug, and having found it once there is no reason to keep rolling for it.
  env: { FIXED_SEED: '4242', ROUND_SECONDS: '180', BOT_COUNT: '0', DEV_LOADOUT: '1' },
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
    // The simulation's tick rate, so the refill assertions can be timed in the
    // sim's own clock rather than the browser's — see the note above them.
    hz: c.SIM_HZ,
  }
})
console.log(
  `  constants: max ${C.max}, drain ${C.drain}/s, refill ${C.refill}/s after ${C.delay}s, ` +
    `SIM_HZ ${C.hz}`,
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
const releasedAt = Date.now()

// --- the refill, SAMPLED FROM THE INSTANT OF RELEASE ------------------------
//
// This block sits here, with nothing between it and the key release, because
// the first version did not. It took its "before" reading *after* a screenshot
// and three assertion blocks, and on a loaded box that gap swallowed the whole
// refill: from the measured 2.16 of 5 at `JETPACK_REFILL` 0.5/s a full tank
// takes 5.7 s, the reading came back `5 -> 5`, and the check reported "the tank
// did not refill" about a tank that had refilled perfectly. It passed on a
// re-run. A gate that fails on how long the machine took gates nothing (§A28),
// so the rise is now watched *while it happens* rather than inferred from two
// readings either side of an unbounded gap.
//
// The window is derived from the constants — `JETPACK_REFILL_DELAY` to start
// moving, then `(max - low) / refill` to fill — never from a wall-clock guess
// that expires the next time either number moves (§A19).
const low = drain[drain.length - 1]
// Bounded, because the obvious falsification of everything below is to set
// `JETPACK_REFILL` to 0 — and `(max - low) / 0` is `Infinity`, which would hang
// this loop rather than fail the assertion it exists to test.
const fillMs = Math.min((C.delay + (C.max - low.fuel) / C.refill) * 1000, 18_000)
const rise = []
while (Date.now() - releasedAt < fillMs + 2000) {
  const d = await dbg()
  // `tick` is the simulation's own clock, and it is the one the assertions
  // below use — see the note above them.
  rise.push({
    t: Date.now() - releasedAt,
    tick: d.lastServerTick,
    // A respawn is the only other thing that can fill this tank —
    // `JetpackState::default()` on `die()`. Carried in every sample so a rate
    // failure can say whether the fuel was refilled or reissued, rather than
    // leaving the next reader to guess. Health alone cannot tell you: respawn
    // restores BASE_HEALTH, so a death inside the window reads as 100 either
    // side of it.
    health: d.health,
    deaths: (d.observed?.deaths ?? []).length,
    // Which of the three discontinuities it was. A respawn moves `deaths`; a
    // round restart walks `roundTime` backwards; a remade session changes the
    // player id. Without these the failure can only say "something reissued the
    // tank" and leave the next reader to run it fifteen more times.
    me: d.me,
    roundTime: d.serverRoundTime ?? d.roundTime,
    ...d.jetpack,
  })
  if (d.jetpack.fuel >= C.max - 0.01) break
  // **Not a tight spin.** The first version had no sleep and made ~440
  // `page.evaluate` calls in 6.7 s, which starves the main thread it is
  // measuring — the observer changing what it observes. 40 ms is still four
  // samples per snapshot at SNAPSHOT_HZ.
  await sleep(40)
}

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
// The measured shape: a flat REFILL_DELAY, then a climb at REFILL/s.
//
// ## Everything here is timed in TICKS, not milliseconds
//
// The wall-clock version of these assertions failed the gate reporting a refill
// of 3.62/s against a `JETPACK_REFILL` of 0.5/s — "faster than the simulation
// allows". It was not. There are exactly three writers of `fuel` in the sim:
// `JetpackState::default()` (a full tank, on construction and on `die()`), the
// drain, and `fuel + JETPACK_REFILL * dt` per tick. **No path can add fuel
// faster than the constant per simulated second.** The failing run had health
// pinned at 100 and zero deaths across a window shorter than `RESPAWN_DELAY`,
// so no respawn happened either.
//
// What did happen: 5.8 s of simulated time arrived in 0.8 s of wall time. The
// client had fallen behind and caught up — and it did so in the one run out of
// fifteen where the player actually flew (y spanned 545 px; in every passing run
// y never moved, the spawn being boxed in). Flying is when the client works
// hardest: camera motion and chunk rebakes. The check's own tight polling loop
// was starving the thread it was measuring.
//
// So the browser's clock is the wrong instrument for a claim about the
// simulation's rate. `lastServerTick` is the simulation's own clock, it is
// already on the debug handle, and a stalled client cannot distort it — a
// backlog of snapshots carries its ticks with it. §A28: a gate that fails on how
// long the machine took gates nothing.
{
  const first = rise[0]
  const last = rise[rise.length - 1]
  // The instrument before the measurement. If the very first sample is already
  // full, this check did not watch a refill — and that is two different things:
  // a real bug if it happened faster than JETPACK_REFILL_DELAY allows, and a
  // stalled harness if the sample simply arrived late. Say which.
  if (!first || first.shown >= C.max - 0.01) {
    const t = first ? first.t : -1
    if (t >= 0 && t < C.delay * 1000) {
      fail(
        `the tank was already full ${t} ms after releasing, inside the ` +
          `${C.delay}s JETPACK_REFILL_DELAY — the refill is not being simulated`,
      )
    } else {
      fail(
        `the first refill sample arrived ${t} ms after releasing, by which time the ` +
          `tank was already full — the harness stalled, so nothing was measured`,
      )
    }
  } else if (!(last.shown > first.shown)) {
    // Summarised, not dumped. This loop takes a sample every few ms, so printing
    // the series put 800 numbers on one line and buried the reading that matters.
    const shown = rise.map((r) => r.shown)
    fail(
      `the tank did not refill after releasing: started ${first.shown}, ended ` +
        `${last.shown}, range ${Math.min(...shown)}-${Math.max(...shown)} over ` +
        `${last.t} ms across ${rise.length} samples`,
    )
  } else {
    const climbed = last.shown - first.shown
    const secs = (last.t - first.t) / 1000
    const simSecs = (last.tick - first.tick) / C.hz
    ok(
      `refilled ${first.shown} -> ${last.shown} (+${climbed.toFixed(1)} in ` +
        `${simSecs.toFixed(1)} simulated s / ${secs.toFixed(1)} s wall, ` +
        `${rise.length} samples)`,
    )
    // The instrument before the measurement, again: if the ticks did not move,
    // every rate below divides by zero and passes.
    if (!(simSecs > 0)) {
      fail(
        `the server tick did not advance across the refill (${first.tick} -> ` +
          `${last.tick}) — there is no simulated clock here to measure against`,
      )
    }
    // The delay is visible in the samples, and it is the half of §C26's shape a
    // bar cannot show: nothing moves for JETPACK_REFILL_DELAY.
    const moved = rise.find((r) => r.fuel > first.fuel + 0.02)
    // The delay, in ticks. A client that stalls for a second and then delivers
    // the backlog reports the *first* climbing sample late in wall time and on
    // time in ticks, so the wall-clock version of this could only ever fail in
    // the safe direction by luck.
    const heldTicks = moved ? moved.tick - first.tick : null
    const delayTicks = C.delay * C.hz
    if (moved && heldTicks + 6 < delayTicks) {
      fail(
        `the tank started climbing ${heldTicks} ticks after releasing, inside the ` +
          `${delayTicks}-tick JETPACK_REFILL_DELAY (${C.delay}s)`,
      )
    } else if (moved) {
      ok(
        `it held for ${heldTicks} ticks before climbing ` +
          `(JETPACK_REFILL_DELAY ${C.delay}s = ${delayTicks} ticks)`,
      )
    }
    // Bounded above by the constant, **per simulated second**. Nothing in the
    // sim can add fuel faster than `JETPACK_REFILL * dt` per tick, so this is a
    // real bound rather than a tolerance: exceeding it means the readout is
    // showing something other than the server's fuel.
    // ## The step, before the average
    //
    // An average over the window cannot tell "refilled too fast" from "the tank
    // was **reissued**" — and reissuing is a real possibility: the only writers
    // of fuel in the sim are the drain, `+ JETPACK_REFILL * dt` per tick, and
    // `JetpackState::default()`, which hands out a full tank on construction and
    // on `die()`. A respawn, a round restart (`round_state` walks
    // `lastServerTick` *backwards*) or a dropped-and-remade session all take the
    // third path, and all three read as an impossible rate.
    //
    // So the largest **single step** is checked against what the ticks between
    // those two samples allow. A gradual overshoot is a rate bug; one sample
    // that vaults is a discontinuity, and the message says which.
    let worst = { gain: 0, ticks: 0, at: 0 }
    for (let i = 1; i < rise.length; i++) {
      const gain = rise[i].fuel - rise[i - 1].fuel
      const ticks = rise[i].tick - rise[i - 1].tick
      if (gain > worst.gain) worst = { gain, ticks, at: rise[i].t }
    }
    // One tick of slack, because a sample can straddle a tick boundary — plus
    // the wire's own resolution. Fuel crosses as a **byte**
    // (`SNAPSHOT_PLAYER_BYTES`), so the smallest change the client can observe is
    // `JETPACK_MAX_FUEL / 255` ≈ 0.02, and a step can carry a quantum of error at
    // each end. Three quanta, expressed as the quantisation rather than as a
    // tolerance typed here — a fixture holding 0.05 stays green against a wire
    // format that changed its resolution (§A19).
    const quantum = C.max / 255
    const allowed = (worst.ticks + 1) * (C.refill / C.hz) + 3 * quantum
    if (worst.gain > allowed) {
      const hs = rise.map((r) => r.health).filter(Number.isFinite)
      fail(
        `the tank gained ${worst.gain.toFixed(2)} across ${worst.ticks} tick(s) at ` +
          `+${worst.at} ms — at JETPACK_REFILL ${C.refill}/s those ticks allow ` +
          `${allowed.toFixed(3)} (including 3 wire quanta of ${quantum.toFixed(3)}). ` +
          `That is not a refill, it is a full tank being ` +
          `reissued. ` +
          (last.deaths > first.deaths
            ? 'A respawn: deaths moved.'
            : last.me !== first.me
              ? `A remade session: the player id went ${first.me} -> ${last.me}.`
              : last.roundTime < first.roundTime
                ? `A round restart: roundTime went ${first.roundTime?.toFixed(1)} -> ` +
                  `${last.roundTime?.toFixed(1)}.`
                : 'None of a respawn, a restart or a new id — so the sim itself did it.') +
          ` (deaths ${first.deaths}->${last.deaths}, health ${Math.min(...hs)}..` +
          `${Math.max(...hs)}, ticks ${first.tick}->${last.tick}, id ${first.me}->${last.me})`,
      )
    } else {
      ok(
        `no step exceeded JETPACK_REFILL: worst +${worst.gain.toFixed(3)} over ` +
          `${worst.ticks} tick(s), allowed ${allowed.toFixed(3)}`,
      )
    }

    const rate = climbed / simSecs
    if (simSecs > 0.5 && rate > C.refill * 1.15) {
      const hs = rise.map((r) => r.health).filter(Number.isFinite)
      fail(
        `refilled ${climbed.toFixed(2)} in ${simSecs.toFixed(1)} simulated s = ` +
          `${rate.toFixed(2)}/s against a JETPACK_REFILL of ${C.refill}/s ` +
          '— that is faster than the simulation allows ' +
          `(deaths ${first.deaths}->${last.deaths}, health ${Math.min(...hs)}..` +
          `${Math.max(...hs)}, wall ${secs.toFixed(1)}s, ${rise.length} samples)`,
      )
    } else {
      ok(
        `the climb is within JETPACK_REFILL: ${rate.toFixed(2)}/simulated s ` +
          `against ${C.refill}/s`,
      )
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

// --- §E13: the health bar goes green while poisoned ------------------------
//
// **The control is a second frame, not a second region.** The subject is one
// bar's colour, and there is no other bar that would go green — so the honest
// control is the same bar on a run where the player is not poisoned, which is
// every assertion above. The rect is captured here and the comparison happens
// against a second stack below.
//
// Why a second stack rather than waiting for rain. Before §F6 the arithmetic was
// decisive: ~20 drops on the whole map per window against a 16 px body is 0.26
// expected hits, and a check that waited for one would have been a coin flip.
// §F6 makes it 54 drops with a `TOXIC_SPLASH_R` reach — about 2.6 expected hits
// — so waiting is no longer hopeless, but a check whose subject arrives 2.6
// times on average still fails one run in fifteen, and a gate that fails on a
// draw gates nothing. `DEV_POISONED` puts the player in the state deterministically.
//
// That a **shower** is what causes it is proved in `game-core` against the real
// scheduler, with a sheltered control in the same run:
// `a_shower_hurts_the_player_in_the_open_and_never_the_one_under_rock`.
//
// §F6's acceptance asks for "the health bar is green during the shower and not
// green before". Both links are measured, and deliberately in the place each can
// be measured without a draw: **shower → poison** in `game-core` above, and
// **poison → green pixels** here, against a clean frame from an unpoisoned stack.
// Photographing a real shower would put a 1-in-15 draw inside the gate to prove
// a join between two things already proved.
const healthRect = await page.evaluate(() => {
  const el = document.getElementById('hud-bar-health')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
})
const cleanPatch = healthRect ? await samplePatch(page, healthRect) : null
const cleanColour = (await dbg()).hudBars?.health?.colour ?? null

if (pageErrors.length) fail(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else ok('no page errors')

await stack.close()

if (!healthRect || !cleanPatch) {
  fail('no health bar rect to compare a poisoned one against')
} else {
  const sick = await startStack({
    port: PORT + 1,
    label: 'hud-bars-poisoned',
    env: {
      FIXED_SEED: '4242',
      ROUND_SECONDS: '180',
      BOT_COUNT: '0',
      DEV_LOADOUT: '1',
      DEV_POISONED: '1',
    },
  })
  const sickClient = await sick.openClient({ name: 'ana' })
  await enterBattle(sickClient.page, { waitPlaying: true, label: 'hud-bars-poisoned' })
  // Past the warmup gate, so the poison is actually biting, but well short of
  // the point where `POISON_MAX_T` hands the bar back to red.
  await sleep(1500)

  const d = await sickClient.dbg()
  const sickColour = d.hudBars?.health?.colour ?? null
  // Both ends (§A39): the wire flag, the colour it produced, and the pixels.
  if (d.hudBars?.poisoned !== true) {
    fail(`the snapshot's poisoned flag is ${d.hudBars?.poisoned} — nothing below is about poison`)
  } else if (sickColour === cleanColour) {
    fail(`poisoned and healthy both compute ${sickColour} — the colour path ignores the flag`)
  } else {
    ok(`poisoned computes ${sickColour}, healthy computed ${cleanColour}`)

    const sickPatch = await samplePatch(sickClient.page, healthRect)
    const delta = Math.hypot(
      sickPatch.r - cleanPatch.r,
      sickPatch.g - cleanPatch.g,
      sickPatch.b - cleanPatch.b,
    )
    // **The direction the computed colours predict, per channel.** The bar is a
    // track with a dark background and white text over it, so the patch mean is
    // not the fill colour and no absolute rgb assertion about it is honest.
    // What is honest is that the frame moved the way `bars-math` said it would.
    //
    // The first version of this asserted "greener" as `g - r` rising, and it
    // failed on a correct frame: §E13's `#7cd44a` is a *yellower* green than
    // full health's `#3ec75a`, so `g - r` falls and `r` rises. Asserting a
    // direction I had assumed instead of one I had computed is what made it
    // wrong — the two hex strings are right there, so the prediction comes from
    // them.
    const hex = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16)
    const chans = ['r', 'g', 'b']
    const wrong = chans.filter((ch, i) => {
      const want = hex(sickColour, i) - hex(cleanColour, i)
      // Channels the two colours barely separate cannot say anything; the frame
      // is composited over a track background and text.
      if (Math.abs(want) < 8) return false
      const got = sickPatch[ch] - cleanPatch[ch]
      return Math.sign(got) !== Math.sign(want)
    })
    if (delta < 4) {
      fail(
        `the poisoned health bar is ${delta.toFixed(1)} away from the healthy one on the ` +
          'frame — the colour was computed and never reached a pixel',
      )
    } else if (wrong.length) {
      fail(
        `the poisoned bar moved by ${delta.toFixed(1)} but channel(s) ${wrong.join(', ')} ` +
          `moved against what ${cleanColour} -> ${sickColour} predicts — ` +
          `rgb ${sickPatch.r.toFixed(0)},${sickPatch.g.toFixed(0)},${sickPatch.b.toFixed(0)} ` +
          `vs ${cleanPatch.r.toFixed(0)},${cleanPatch.g.toFixed(0)},${cleanPatch.b.toFixed(0)}`,
      )
    } else {
      ok(
        `the poisoned health bar moved on the frame exactly as ${cleanColour} -> ` +
          `${sickColour} predicts (delta ${delta.toFixed(1)}, rgb ` +
          `${sickPatch.r.toFixed(0)},${sickPatch.g.toFixed(0)},${sickPatch.b.toFixed(0)} ` +
          `vs ${cleanPatch.r.toFixed(0)},${cleanPatch.g.toFixed(0)},${cleanPatch.b.toFixed(0)})`,
      )
    }
    await sickClient.shot('hud-bars-poisoned')
  }
  await sick.close()
}
console.log(failures.length ? `\nhud-bars: ${failures.length} FAILED` : '\nhud-bars: ok')
process.exit(failures.length ? 1 : 0)
