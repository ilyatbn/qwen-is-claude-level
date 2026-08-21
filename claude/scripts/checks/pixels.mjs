/**
 * `pixels` — the shared harness for asserting on **rendered pixels**, and its own
 * self-test (`docs/72` §C2).
 *
 * Four "I cannot see it" bugs shipped past 905 tests because every assertion about
 * the world checked simulation state (mask checksums, solid-pixel counts) or client
 * bookkeeping (draw counters, tracked-vs-drawn). None checked the frame. This is the
 * fifth instance of §A15/§B21 — *fog's formula was always right; nothing tested that
 * the number reached the screen.*
 *
 * Three traps this encodes, each paid for once already:
 *
 *   - **Phaser does not preserve the WebGL drawing buffer.** Reading the canvas
 *     directly returns zeros. Every sample here comes from a screenshot.
 *   - **A whole-frame mean hides everything** (§A15): the sky dominates it and the
 *     sky legitimately changes. Sample the region where the change is.
 *   - **A change with no control is not evidence** (§A16). `assertChanged` *requires*
 *     a control region, because "these pixels differ" also passes for a canvas that
 *     is different every frame.
 */

/**
 * Mean colour of a rectangle of the rendered frame.
 *
 * Decoded in-page rather than in node: it keeps this dependency-free and it is the
 * approach `night_darkens_the_world.mjs` already proved. `clip` means we decode a
 * patch, not a 1280x720 frame, per sample.
 */
export async function samplePatch(page, { x, y, w, h }) {
  const b64 = (await page.screenshot({ clip: { x, y, width: w, height: h } })).toString('base64')
  return page.evaluate(async (src) => {
    const img = new Image()
    img.src = `data:image/png;base64,${src}`
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.width
    cv.height = img.height
    const ctx = cv.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    let r = 0
    let g = 0
    let b = 0
    // A digest, so "different pixels arranged to the same mean" still registers.
    // A mean alone cannot tell a crater from a recolour.
    let digest = 2166136261
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]
      g += d[i + 1]
      b += d[i + 2]
      digest = Math.imul(digest ^ d[i], 16777619) ^ d[i + 1] ^ d[i + 2]
    }
    const n = d.length / 4
    return {
      r: r / n,
      g: g / n,
      b: b / n,
      lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n,
      digest: digest >>> 0,
      n,
    }
  }, b64)
}

/** Euclidean distance between two samples' mean colours. */
export function colourDelta(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
}

/**
 * Assert a region changed **and** a control region did not.
 *
 * The control is not optional. Without it this passes for a canvas that is
 * different every frame — which is most canvases, since the sky moves.
 */
export function assertChanged(before, after, { label, control, minDelta = 8 } = {}) {
  if (!control || !control.before || !control.after) {
    throw new Error(`assertChanged(${label}): a control region is required (§C2)`)
  }
  const d = colourDelta(before, after)
  const c = colourDelta(control.before, control.after)
  // The digest is part of the DECISION, not just the message. It used to be
  // computed, self-tested, and then ignored — `assertChanged` decided on the mean
  // alone while its own failure text printed "Same digest: false". A harness that
  // advertises a capability in a comment, proves it in a self-test and leaves it
  // out of the branch is the exact shape of bug this harness exists to catch.
  const rearranged = before.digest !== after.digest
  if (d < minDelta && !rearranged) {
    throw new Error(
      `${label}: expected the region to change, but it moved only ${d.toFixed(1)} ` +
        `(threshold ${minDelta}) and the digest is identical — nothing moved at all`,
    )
  }
  if (d < minDelta) {
    throw new Error(
      `${label}: the mean moved only ${d.toFixed(1)} (threshold ${minDelta}), though ` +
        `the pixels did rearrange. Too subtle to call a change — sample where the ` +
        `change is (§A15), or lower the threshold deliberately`,
    )
  }
  if (c >= minDelta) {
    throw new Error(
      `${label}: the CONTROL region also changed by ${c.toFixed(1)} — the frame is ` +
        `different everywhere, so the change proves nothing about the subject`,
    )
  }
  return { delta: d, controlDelta: c }
}

/** Assert a region did not change. Used for the other half of a control pair. */
export function assertUnchanged(before, after, { label, maxDelta = 4 } = {}) {
  const d = colourDelta(before, after)
  if (d > maxDelta) {
    throw new Error(`${label}: expected no change, but it moved ${d.toFixed(1)}`)
  }
  return { delta: d }
}

// --------------------------------------------------------------- the self-test

const SYNTH = (subject, control) => `
  <body style="margin:0;background:#202830">
    <div id="subject" style="position:absolute;left:100px;top:100px;width:120px;height:120px;background:${subject}"></div>
    <div id="control" style="position:absolute;left:400px;top:100px;width:120px;height:120px;background:${control}"></div>
  </body>`

export default async function ({ page, shot, log }) {
  const subject = { x: 100, y: 100, w: 120, h: 120 }
  const control = { x: 400, y: 100, w: 120, h: 120 }

  // 1. A real change with a still control — must pass.
  await page.setContent(SYNTH('#204020', '#802020'))
  const s0 = await samplePatch(page, subject)
  const c0 = await samplePatch(page, control)
  await page.setContent(SYNTH('#20c020', '#802020'))
  const s1 = await samplePatch(page, subject)
  const c1 = await samplePatch(page, control)
  await shot('pixels-selftest')

  const r = assertChanged(s0, s1, {
    label: 'synthetic subject',
    control: { before: c0, after: c1 },
  })
  log(`change detected: subject moved ${r.delta.toFixed(1)}, control ${r.controlDelta.toFixed(1)}`)

  // 2. Nothing changed — must FAIL. A harness that cannot report "no change" is
  //    the §A15 failure it exists to prevent, so prove it fails.
  let caught = null
  try {
    assertChanged(s1, s1, { label: 'unchanged', control: { before: c0, after: c1 } })
  } catch (e) {
    caught = e.message
  }
  if (!caught) throw new Error('assertChanged passed on an identical pair — it cannot fail')
  log(`no-change correctly rejected: ${caught.split('.')[0]}`)

  // 3. The control also changed — must FAIL. This is the assertion that stops a
  //    frame which differs everywhere from proving anything about the subject.
  caught = null
  try {
    assertChanged(s0, s1, { label: 'moving control', control: { before: s0, after: s1 } })
  } catch (e) {
    caught = e.message
  }
  if (!caught) throw new Error('assertChanged passed with a control that also changed')
  log(`moving control correctly rejected`)

  // 4. A missing control must be refused outright, not silently defaulted.
  caught = null
  try {
    assertChanged(s0, s1, { label: 'no control' })
  } catch (e) {
    caught = e.message
  }
  if (!caught) throw new Error('assertChanged accepted a missing control')
  log('missing control correctly refused')

  // 5. The digest catches a rearrangement a mean cannot. Two patches with the
  //    same mean and different pixels must not read as identical.
  await page.setContent(`
    <body style="margin:0;background:#202830">
      <div id="subject" style="position:absolute;left:100px;top:100px;width:120px;height:120px;
        background:linear-gradient(90deg,#000 50%,#fff 50%)"></div>
      <div id="control" style="position:absolute;left:400px;top:100px;width:120px;height:120px;background:#802020"></div>
    </body>`)
  const split = await samplePatch(page, subject)
  await page.setContent(`
    <body style="margin:0;background:#202830">
      <div id="subject" style="position:absolute;left:100px;top:100px;width:120px;height:120px;
        background:linear-gradient(90deg,#fff 50%,#000 50%)"></div>
      <div id="control" style="position:absolute;left:400px;top:100px;width:120px;height:120px;background:#802020"></div>
    </body>`)
  const flipped = await samplePatch(page, subject)
  if (Math.abs(split.lum - flipped.lum) > 2) {
    throw new Error(`the mirrored gradients should have the same mean; got ${split.lum} vs ${flipped.lum}`)
  }
  if (split.digest === flipped.digest) {
    throw new Error('the digest did not distinguish two arrangements with the same mean')
  }
  log(`digest distinguishes equal-mean arrangements (lum ${split.lum.toFixed(1)} both)`)
}
