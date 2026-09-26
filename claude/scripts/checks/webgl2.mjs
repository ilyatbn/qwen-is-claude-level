/**
 * `webgl2` — T23.00: the checks' Chromium has WebGL2 **and** renderable half-float colour buffers.
 *
 * three.js 0.170 needs WebGL2, and M23's post chain (bloom, ACES tonemap) renders into RGBA16F
 * targets. Without either, every later M23 check photographs a black canvas and fails as
 * "wrong pixels" — this one fails first, **by name**, and says which half is missing.
 *
 * Half-float is asserted by effect (a 2.0 clear reads back above 1), with the RGBA8 target that
 * clamps the same clear to 1 as its control — a readback that cannot tell the two apart fails.
 * The browser under test is `lib/browser-args.mjs`'s: R14's low tier is swiftshader, so a
 * software renderer is expected here and logged, not failed.
 */
import { webglInfo, describe } from '../lib/webgl-info.mjs'

export default async function ({ page, shot, log }) {
  const info = await page.evaluate(webglInfo)
  log(describe(info))
  log(JSON.stringify(info))
  const fail = (what) => {
    throw new Error(`webgl2: ${what} — every M23 renderer check needs it (${JSON.stringify(info)})`)
  }
  if (!info.webgl2) fail(`no WebGL2 context${info.reason ? ` (${info.reason})` : ''}`)
  if (!info.halfFloatComplete) fail('an RGBA16F framebuffer is not complete (no half-float colour buffers)')
  if (!(info.halfFloatReadback > 1.5)) fail(`RGBA16F clamps: 2.0 read back as ${info.halfFloatReadback}`)
  // Control: the 8-bit target must clamp, or the readback is not measuring precision at all.
  if (!(info.rgba8Readback !== null && info.rgba8Readback <= 1)) {
    fail(`control: RGBA8 did not clamp 2.0 (read ${info.rgba8Readback}) — the readback proves nothing`)
  }
  log(`half-float 2.0 → ${info.halfFloatReadback}; RGBA8 control → ${info.rgba8Readback}`)
  // The runner requires a picture; this one is the title screen the same browser drew.
  await shot('webgl2')
}
