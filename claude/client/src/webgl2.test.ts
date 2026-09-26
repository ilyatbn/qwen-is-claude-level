import { describe, expect, it } from 'vitest'
import {
  REQUIRE_WEBGL2,
  WEBGL2_MESSAGE_ID,
  gateOnWebgl2,
  probeWebgl2,
  type MessageDocument,
  type MessageElement,
  type ProbeCanvas,
} from './webgl2'

type Listener = (e: { statusMessage?: string }) => void

/** A canvas whose `getContext('webgl2')` returns `ctx`, firing the browser's error event first. */
function stubCanvas(ctx: unknown, statusMessage?: string): ProbeCanvas & { listeners: Set<Listener> } {
  const listeners = new Set<Listener>()
  return {
    listeners,
    getContext: () => {
      if (!ctx) for (const l of listeners) l(statusMessage === undefined ? {} : { statusMessage })
      return ctx
    },
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  }
}

interface StubEl extends MessageElement<StubEl> {
  kids: StubEl[]
}

function stubDoc(): MessageDocument<StubEl> & { children: StubEl[] } {
  const el = (): StubEl => {
    const kids: StubEl[] = []
    return { id: '', textContent: null, style: { cssText: '' }, kids, appendChild: (c) => kids.push(c) }
  }
  const children: StubEl[] = []
  return { children, createElement: () => el(), body: { appendChild: (c) => children.push(c) } }
}

/** Every text in the element tree, in order. */
function texts(e: StubEl): string[] {
  return [e.textContent ?? '', ...e.kids.flatMap(texts)].filter(Boolean)
}

const REASON = 'disabled by enterprise policy or commandline switch'

describe('probeWebgl2', () => {
  it('reports no WebGL2, with the browser reason, when getContext returns null', () => {
    const cv = stubCanvas(null, REASON)
    expect(probeWebgl2(cv)).toEqual({ ok: false, reason: REASON })
    expect(cv.listeners.size).toBe(0)
  })
  it('reports WebGL2 when getContext returns a context (presence control)', () => {
    expect(probeWebgl2(stubCanvas({}))).toEqual({ ok: true })
  })

  // T23.04C (R22): a probe context left to the collector stays live beside Phaser's and three's.
  it('releases the context it made (WEBGL_lose_context), once', () => {
    let lost = 0
    const asked: string[] = []
    const gl = {
      getExtension(name: string) {
        asked.push(name)
        return name === 'WEBGL_lose_context' ? { loseContext: () => lost++ } : null
      },
    }
    expect(probeWebgl2(stubCanvas(gl))).toEqual({ ok: true })
    expect(asked).toEqual(['WEBGL_lose_context'])
    expect(lost).toBe(1)
  })
})

describe('gateOnWebgl2', () => {
  it('when required: no WebGL2 shows the full-screen message and stops the boot', () => {
    const doc = stubDoc()
    expect(gateOnWebgl2(stubCanvas(null, REASON), doc, true)).toBe(false)
    expect(doc.children).toHaveLength(1)
    const box = doc.children[0]!
    expect(box.id).toBe(WEBGL2_MESSAGE_ID)
    expect(box.style.cssText).toContain('position:fixed')
    const t = texts(box)
    expect(t[0]).toBe('This game needs WebGL2')
    expect(t.some((s) => s.includes(REASON))).toBe(true)
  })
  it('when required: a context boots normally and shows nothing', () => {
    const doc = stubDoc()
    expect(gateOnWebgl2(stubCanvas({}), doc, true)).toBe(true)
    expect(doc.children).toHaveLength(0)
  })
  it('when not required: no WebGL2 still boots, shows nothing, and says why in the console', () => {
    const doc = stubDoc()
    const warned: string[] = []
    expect(gateOnWebgl2(stubCanvas(null, REASON), doc, false, (m) => warned.push(m))).toBe(true)
    expect(doc.children).toHaveLength(0)
    expect(warned.join()).toContain(REASON)
  })
  it('is not enforced until T23.03 retires the Canvas world path', () => {
    // The default `main.ts` passes. When T23.03 flips it, this line flips with it.
    expect(REQUIRE_WEBGL2).toBe(false)
    const doc = stubDoc()
    expect(gateOnWebgl2(stubCanvas(null), doc, undefined, () => {})).toBe(true)
    expect(doc.children).toHaveLength(0)
  })
})
