/** T24.01 task 4: the alien cow's animation — chewing, the tongue near a tree and not away from one, sleep at night. */
import { describe, expect, it } from 'vitest'
import { COW_SLEEP_NIGHT, COW_STILL_S, COW_TONGUE_REACH, TONGUE_PERIOD_S, TONGUE_STEPS, chewPose, cowActor, cowMouth, tonguePose, tongueTarget, type CowState } from './cow'

const TREE = { x: 500, y: 400, flip: false }
const cow = (o: Partial<CowState> = {}): CowState => ({ id: 3, x: 450, y: 391, w: 30, h: 18, right: true, still: 5, gait: 0, ...o })

describe('alien cow (T24.01)', () => {
  it('finds the canopy from beside the trunk, and nothing from across the map (control)', () => {
    const near = tongueTarget(cowMouth(450, 400, true), [TREE])
    expect(near).not.toBeNull()
    expect(Math.hypot(...(near ?? [0, 0]))).toBeLessThanOrEqual(COW_TONGUE_REACH)
    expect(tongueTarget(cowMouth(1500, 400, true), [TREE])).toBeNull()
    expect(tongueTarget(cowMouth(450, 400, true), [])).toBeNull()
  })

  it('reaches the canopy from beside the tree, where it grazes in full view (the owner: "just extend the tongue")', () => {
    // At the inner edge of its band (140 px from the trunk, facing it) and at the outer (230), on the tree's level.
    for (const off of [140, 185, 230]) {
      expect(tongueTarget(cowMouth(TREE.x - off, TREE.y, true), [TREE]), `${off} px left`).not.toBeNull()
      expect(tongueTarget(cowMouth(TREE.x + off, TREE.y, false), [TREE]), `${off} px right`).not.toBeNull()
    }
  })

  it('reaches out and back each period, curling a different way each reach — the random pattern', () => {
    const outs = new Set<number>()
    for (let k = 0; k < TONGUE_STEPS; k++) outs.add(tonguePose((k + 0.5) * (TONGUE_PERIOD_S / TONGUE_STEPS), 3).out)
    expect(outs.has(0)).toBe(true)
    expect(Math.max(...outs)).toBeGreaterThan(0.9)
    // Two reaches of one cow, and the same reach of two cows, curl differently; the same reach twice is the same.
    const mid = TONGUE_PERIOD_S * 0.3
    const curls = Array.from({ length: 8 }, (_, c) => tonguePose(c * TONGUE_PERIOD_S + mid, 3).curl)
    expect(new Set(curls).size).toBeGreaterThan(3)
    expect(tonguePose(mid, 3)).toEqual(tonguePose(mid, 3))
    expect(tonguePose(mid, 3).curl).not.toBe(tonguePose(mid, 4).curl)
  })

  it('chews while it stands', () => {
    const jaws = new Set(Array.from({ length: 20 }, (_, i) => chewPose(i * 0.05, 3)))
    expect(jaws.size).toBeGreaterThan(1)
  })

  it('grazing by its tree it reaches its tongue; walking, or far from a tree, it does not (controls)', () => {
    const t = TONGUE_PERIOD_S * 0.45
    const grazing = cowActor(cow(), 0, t, [TREE])
    expect(grazing.kind).toBe('cow')
    expect(grazing.opts.tongue?.out ?? 0).toBeGreaterThan(0.5)
    const walking = cowActor(cow({ still: COW_STILL_S / 2, gait: 0.4 }), 0, t, [TREE])
    expect(walking.opts.tongue ?? null).toBeNull()
    expect(walking.opts.gait).toBeGreaterThan(0)
    const away = cowActor(cow({ x: 1500 }), 0, t, [TREE])
    expect(away.opts.tongue ?? null).toBeNull()
    // Away from the tree it chews instead (some step of the chew is open).
    const chews = Array.from({ length: 12 }, (_, i) => cowActor(cow({ x: 1500 }), 0, i * 0.06, [TREE]).opts.chew ?? 0)
    expect(Math.max(...chews)).toBeGreaterThan(0)
  })

  it('faces its tongue: a cow facing left gets the world offset mirrored into its drawing', () => {
    const t = TONGUE_PERIOD_S * 0.45
    const c = cow({ x: 560, right: false })
    const raw = tongueTarget(cowMouth(c.x, c.y + c.h / 2, false), [TREE])
    const l = cowActor(c, 0, t, [TREE]).opts.tongue
    expect(raw).not.toBeNull()
    expect(l?.to).toEqual([-(raw?.[0] ?? 0), raw?.[1]])
    const r = cowActor(cow({ x: 440 }), 0, t, [TREE]).opts.tongue
    const rawR = tongueTarget(cowMouth(440, 400, true), [TREE])
    expect(r?.to).toEqual(rawR)
  })

  it('sleeps at night when still — head down, no tongue — and not by day (control)', () => {
    const night = cowActor(cow(), COW_SLEEP_NIGHT + 0.1, 1, [TREE])
    expect(night.opts.sleep).toBe(true)
    expect(night.opts.tongue ?? null).toBeNull()
    expect(cowActor(cow(), 0, 1, [TREE]).opts.sleep).toBe(false)
  })
})
