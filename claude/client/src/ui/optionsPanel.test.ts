import { describe, expect, it } from 'vitest'
import { QUALITY_HINT, QUALITY_HINT_NO_WEBGL, qualityRow } from './optionsPanel'

describe('qualityRow (T21.33)', () => {
  it('follows the stored setting where shaders can run', () => {
    // Both values, or a row that ignored the setting would pass with one.
    expect(qualityRow(true, true)).toEqual({ on: true, disabled: false, hint: QUALITY_HINT })
    expect(qualityRow(true, false)).toEqual({ on: false, disabled: false, hint: QUALITY_HINT })
  })

  it('is disabled and Off with no WebGL, even when On is stored', () => {
    expect(qualityRow(false, true)).toEqual({ on: false, disabled: true, hint: QUALITY_HINT_NO_WEBGL })
    expect(qualityRow(false, false)).toEqual({ on: false, disabled: true, hint: QUALITY_HINT_NO_WEBGL })
  })
})
