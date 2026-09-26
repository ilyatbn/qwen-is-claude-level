/**
 * What WebGL a page gets, read **in the page** — one function for the three readers
 * (`checks/webgl2.mjs`, `webgl2-probe.mjs`, `probe.mjs`), so "the checks' browser has
 * half-float targets" and "the owner's window has half-float targets" are the same
 * measurement.
 *
 * Pass it to `page.evaluate` as is: it is serialised by source, so it must not close
 * over anything in this module.
 *
 * Half-float is measured by **effect**, not by extension name: a 2.0 cleared into an
 * RGBA16F target must read back above 1 (M23's bloom and tonemap need values above 1).
 * The control is the same clear into an RGBA8 target, which clamps to 1 — so a
 * readback that could not tell the two apart would fail the control, not pass.
 */
export function webglInfo() {
  const out = {
    webgl2: false,
    webgl1: false,
    reason: null,
    vendor: null,
    renderer: null,
    software: null,
    extHalfFloat: false,
    extFloat: false,
    halfFloatComplete: false,
    halfFloatReadback: null,
    rgba8Readback: null,
  }
  const cv = document.createElement('canvas')
  cv.addEventListener('webglcontextcreationerror', (e) => {
    out.reason = e.statusMessage || out.reason
  })
  let gl = cv.getContext('webgl2')
  out.webgl2 = !!gl
  if (!gl) {
    const cv1 = document.createElement('canvas')
    cv1.addEventListener('webglcontextcreationerror', (e) => {
      out.reason = out.reason ?? (e.statusMessage || null)
    })
    gl = cv1.getContext('webgl')
    out.webgl1 = !!gl
  }
  if (!gl) return out
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
  out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  out.software = /swiftshader|llvmpipe|softpipe|software/i.test(String(out.renderer))
  if (!out.webgl2) return out
  out.extFloat = !!gl.getExtension('EXT_color_buffer_float')
  out.extHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float')

  /** Clear a 4×4 target of `internal` to 2.0 and read the red channel back. */
  const clearAndRead = (internal, readType) => {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, 4, 4)
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    let value = null
    if (complete) {
      gl.clearColor(2, 2, 2, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const px = readType === gl.FLOAT ? new Float32Array(4) : new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, readType, px)
      value = readType === gl.FLOAT ? px[0] : px[0] / 255
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(tex)
    return { complete, value }
  }
  const half = clearAndRead(gl.RGBA16F, gl.FLOAT)
  out.halfFloatComplete = half.complete
  out.halfFloatReadback = half.value
  out.rgba8Readback = clearAndRead(gl.RGBA8, gl.UNSIGNED_BYTE).value
  return out
}

/** One line a person reads at a glance: GPU or CPU, and which. */
export function describe(info) {
  if (!info.webgl2 && !info.webgl1) return `webgl   NONE${info.reason ? ` — ${info.reason}` : ''}`
  const kind = info.software ? 'CPU (software)' : 'GPU'
  return `webgl   ${info.webgl2 ? 'webgl2' : 'webgl1 only'}  ${kind}  ${info.renderer}`
}
