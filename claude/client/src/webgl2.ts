/**
 * T23.00 / R2: does this browser have WebGL2, and if not, tell the player plainly.
 *
 * three.js 0.170 (M23's world renderer, R1) needs WebGL2 and has no Canvas path, so a
 * machine without it gets a full-screen message instead of a broken game.
 *
 * **Not enforced yet.** Until the three.js world renderer exists (`T23.03`) the game still
 * draws through Phaser, which falls back to Canvas and runs fine without WebGL2 — blocking
 * those players now would take a working game away for nothing. So `main.ts` runs the probe
 * and `gateOnWebgl2` shows the message only when `REQUIRE_WEBGL2` is true. **`T23.03` flips
 * it**, in the same commit that retires the Canvas world path.
 */

/**
 * Flipped to `true` when three.js draws the world and Canvas can no longer (R2). **Not at T23.03**,
 * which the T23.00 note named: T23.03 puts three.js under Phaser with one test layer, the world is
 * still Phaser's and a machine without WebGL2 still plays (the world renderer falls back to a stub).
 * The first task whose layer a Canvas-only machine would miss — the sky, T23.04 — is the earliest.
 */
export const REQUIRE_WEBGL2 = false

/** Id of the message element, for anything that needs to find it. */
export const WEBGL2_MESSAGE_ID = 'webgl2-required'

/** The slice of a canvas the probe uses — a stub in tests, a real `<canvas>` in `main.ts`. */
export interface ProbeCanvas {
  getContext(id: 'webgl2'): unknown
  addEventListener(type: 'webglcontextcreationerror', fn: (e: { statusMessage?: string }) => void): void
  removeEventListener(type: 'webglcontextcreationerror', fn: (e: { statusMessage?: string }) => void): void
}

export type Webgl2Probe = { ok: true } | { ok: false; reason: string | null }

/**
 * Ask for a WebGL2 context on a throwaway canvas. The browser's own reason, when it gives one,
 * arrives on `webglcontextcreationerror` during `getContext` (Chrome fills `statusMessage`, e.g.
 * "disabled by enterprise policy or commandline switch").
 */
export function probeWebgl2(canvas: ProbeCanvas): Webgl2Probe {
  let reason: string | null = null
  const onError = (e: { statusMessage?: string }) => {
    if (e.statusMessage) reason = e.statusMessage
  }
  canvas.addEventListener('webglcontextcreationerror', onError)
  let ctx: unknown = null
  try {
    ctx = canvas.getContext('webgl2')
  } catch (e) {
    reason = reason ?? String(e)
  }
  canvas.removeEventListener('webglcontextcreationerror', onError)
  return ctx ? { ok: true } : { ok: false, reason }
}

/** The words a player reads. Plain, and says what to try. */
export function webgl2MessageText(reason: string | null): { title: string; body: string; detail: string | null } {
  return {
    title: 'This game needs WebGL2',
    body:
      'Your browser could not start WebGL2, which the game uses to draw the world. ' +
      'Try an up-to-date Chrome, Edge or Firefox, and make sure hardware acceleration ' +
      'is turned on in the browser settings.',
    // Chrome's reason can run to 400 characters of driver ids; the first 160 say what failed.
    detail: reason ? `The browser said: ${reason.length > 160 ? `${reason.slice(0, 160)}…` : reason}` : null,
  }
}

/** The slice of `document` the message needs; `E` is `HTMLElement` in `main.ts`, a stub in tests. */
export interface MessageDocument<E extends MessageElement<E>> {
  createElement(tag: 'div' | 'h1' | 'p'): E
  body: { appendChild(el: E): unknown }
}
export interface MessageElement<E> {
  id: string
  textContent: string | null
  style: { cssText: string }
  appendChild(el: E): unknown
}

/** Put the full-screen message on the page and return it. */
export function showWebgl2Message<E extends MessageElement<E>>(doc: MessageDocument<E>, reason: string | null): E {
  const text = webgl2MessageText(reason)
  const box = doc.createElement('div')
  box.id = WEBGL2_MESSAGE_ID
  box.style.cssText =
    'position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:12px;padding:24px;background:#0b1020;color:#e8ecf4;' +
    'font:18px/1.5 system-ui,sans-serif;text-align:center'
  const h = doc.createElement('h1')
  h.textContent = text.title
  h.style.cssText = 'margin:0;font-size:32px'
  box.appendChild(h)
  const p = doc.createElement('p')
  p.textContent = text.body
  p.style.cssText = 'margin:0;max-width:560px'
  box.appendChild(p)
  if (text.detail) {
    const d = doc.createElement('p')
    d.textContent = text.detail
    d.style.cssText = 'margin:0;max-width:560px;font-size:14px;opacity:0.7'
    box.appendChild(d)
  }
  doc.body.appendChild(box)
  return box
}

/**
 * `main.ts`'s one call, before any scene boots: `true` means boot the game. With `require`
 * false (today) it always boots and only logs a missing WebGL2; with `require` true a missing
 * WebGL2 shows the message and stops the boot.
 */
export function gateOnWebgl2<E extends MessageElement<E>>(
  canvas: ProbeCanvas,
  doc: MessageDocument<E>,
  require: boolean = REQUIRE_WEBGL2,
  warn: (msg: string) => void = console.warn,
): boolean {
  const probe = probeWebgl2(canvas)
  if (probe.ok) return true
  if (!require) {
    warn(`WebGL2 unavailable (${probe.reason ?? 'no reason given'}); running on the Canvas fallback`)
    return true
  }
  showWebgl2Message(doc, probe.reason)
  return false
}
