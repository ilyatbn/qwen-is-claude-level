/**
 * T23.09B: `world-canvas`' marker search reads a crossing only where the probe line crosses a bar —
 * a magenta run the bar's thickness — never the run it finds first.
 */
import { describe, expect, it } from 'vitest'
import { crossing } from './worldHandle'

const BAR = 24

describe('crossing (T23.09B)', () => {
  it("the red run's shape: the line along the tall bar, cut by the moon's glow in one canvas — no crossing in either", () => {
    // Measured on the red run (gate-t2309b-inst1.txt, frame 628): Phaser [[0,719]], three [[0,92],[134,718]].
    // The old search took each first run's centre: 359.5 vs 46 — the 313.5 px "disagreement".
    expect(crossing([[0, 719]], BAR)).toEqual({ at: null, ambiguous: false })
    expect(crossing([[0, 92], [134, 718]], BAR)).toEqual({ at: null, ambiguous: false })
  })

  it('a bar-thick run is the crossing, whatever else is on the line (presence control)', () => {
    expect(crossing([[940, 963]], BAR)).toEqual({ at: 951.5, ambiguous: false })
    expect(crossing([[0, 92], [940, 962], [990, 1200]], BAR)).toEqual({ at: 951, ambiguous: false })
  })

  it('two bar-thick runs are ambiguous, not a pick', () => {
    expect(crossing([[100, 123], [940, 963]], BAR)).toEqual({ at: null, ambiguous: true })
  })
})
