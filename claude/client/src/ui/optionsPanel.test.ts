import { describe, expect, it } from 'vitest'
import { OptionsPanel, QUALITY_HINT, QUALITY_HINT_NO_WEBGL, qualityRow } from './optionsPanel'
import { HIGH_QUALITY_KEY, highQualityChoice, loadSettings, resetSettingsForTest } from './settings'

describe('qualityRow (T21.33, R20)', () => {
  it('follows the stored setting where shaders can run, whatever was detected', () => {
    // Both values, or a row that ignored the setting would pass with one; both detections,
    // or a row that let detection override an explicit choice would pass.
    for (const d of ['full', 'low'] as const) {
      expect(qualityRow(true, true, d)).toEqual({ on: true, label: 'On', disabled: false, hint: QUALITY_HINT })
      expect(qualityRow(true, false, d)).toEqual({ on: false, label: 'Off', disabled: false, hint: QUALITY_HINT })
    }
  })

  it('reads Auto with the detected tier when the player never chose', () => {
    expect(qualityRow(true, null, 'full')).toEqual({ on: true, label: 'Auto (Full)', disabled: false, hint: QUALITY_HINT })
    expect(qualityRow(true, null, 'low')).toEqual({ on: false, label: 'Auto (Low)', disabled: false, hint: QUALITY_HINT })
  })

  it('is disabled and Off with no WebGL, even when On is stored or detected', () => {
    for (const c of [true, false, null]) {
      expect(qualityRow(false, c, 'full')).toEqual({ on: false, label: 'Off', disabled: true, hint: QUALITY_HINT_NO_WEBGL })
    }
  })
})

/** The few DOM calls the panel makes, so its click can be driven in node (vitest runs without a DOM). */
function fakeDoc(): { doc: Document; byId: (id: string) => FakeEl } {
  const all: FakeEl[] = []
  const make = (): FakeEl => {
    const el: FakeEl = {
      id: '',
      textContent: '',
      hidden: false,
      disabled: false,
      style: {} as Record<string, string>,
      attrs: {},
      clicks: [],
      setAttribute(k: string, v: string) {
        el.attrs[k] = v
      },
      addEventListener(_t: string, fn: () => void) {
        el.clicks.push(fn)
      },
      append() {},
      appendChild() {},
      remove() {},
      click() {
        if (!el.disabled) el.clicks.forEach((f) => f())
      },
    }
    all.push(el)
    return el
  }
  const doc = { createElement: make, body: make() } as unknown as Document
  return { doc, byId: (id) => all.find((e) => e.id === id)! }
}
interface FakeEl {
  id: string
  textContent: string
  hidden: boolean
  disabled: boolean
  style: Record<string, string>
  attrs: Record<string, string>
  clicks: (() => void)[]
  setAttribute(k: string, v: string): void
  addEventListener(t: string, fn: () => void): void
  append(...n: unknown[]): void
  appendChild(n: unknown): void
  remove(): void
  click(): void
}

describe('OptionsPanel from Auto (R20)', () => {
  for (const [detected, label, stored] of [
    ['full', 'Auto (Full)', '0'],
    ['low', 'Auto (Low)', '1'],
  ] as const) {
    it(`reads ${label} never chosen, and one click stores ${stored} explicitly`, () => {
      resetSettingsForTest()
      const store = new Map<string, string>()
      loadSettings({ getItem: (k) => store.get(k) ?? null })
      const { doc, byId } = fakeDoc()
      new OptionsPanel(
        { shadersAvailable: true, onClose() {}, storage: { setItem: (k, v) => void store.set(k, v) }, detectedTier: () => detected },
        doc,
      )
      const btn = byId('options-quality')
      expect(btn.textContent).toBe(label)
      expect(store.has(HIGH_QUALITY_KEY)).toBe(false)
      btn.click()
      expect(store.get(HIGH_QUALITY_KEY)).toBe(stored)
      expect(highQualityChoice()).toBe(stored === '1')
      expect(btn.textContent).toBe(stored === '1' ? 'On' : 'Off')
      resetSettingsForTest()
    })
  }
})
