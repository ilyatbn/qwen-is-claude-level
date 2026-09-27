import { describe, expect, it } from 'vitest'
import type Phaser from 'phaser'
import type { Actor } from '../scene'
import { castOf, joinCast } from './cast'
import { GATE_ART_W, GATE_CHARGE_STEPS, gateActor, gateGeometry, gateInner, overlapsAny, overlapsBoxes, steppedCharge, turretActor, turretFace } from './props'

const actor = (kind: Actor['kind'], x: number): Actor => ({ kind, x, y: 0, opts: {}, lit: null, box: null })

describe('T23.19A: props in the world renderer', () => {
  it('draws the props behind the figures whatever order they joined in', () => {
    const scene = {} as Phaser.Scene
    joinCast(scene, { actor: () => actor('figure', 1) })
    joinCast(scene, { back: true, actor: () => actor('turret', 2) })
    joinCast(scene, { actor: () => actor('figure', 3) })
    const leave = joinCast(scene, { back: true, actor: () => actor('gate', 4) })
    expect(castOf(scene).map((a) => a.x)).toEqual([2, 4, 1, 3])
    leave()
    expect(castOf(scene).map((a) => a.kind)).toEqual(['turret', 'figure', 'figure'])
  })

  it('sizes the gate to the width it is handed and puts its window where the stones ring it', () => {
    const w = GATE_ART_W * 1.3
    const g = gateGeometry(w)
    expect(g.gw).toBeCloseTo(w, 9)
    expect(gateActor(0, 0, w, 0).opts.s).toBeCloseTo(1.3, 9)
    // The window sits inside the stone, under its top.
    expect(g.rx).toBeLessThan(g.gw / 2)
    expect(-g.dy + g.ry).toBeLessThan(g.gh)
  })

  it('fills the window with the charge, in steps, from the idle haze to the charged one', () => {
    expect(gateInner(0)).not.toBe(gateInner(1))
    expect(gateInner(-3)).toBe(gateInner(0))
    expect(gateInner(7)).toBe(gateInner(1))
    const seen = new Set<string>()
    for (let i = 0; i <= 1000; i++) seen.add(gateInner(i / 1000))
    expect(seen.size).toBe(GATE_CHARGE_STEPS + 1)
    expect(steppedCharge(0.5)).toBeCloseTo(0.5, 9)
    expect(gateActor(0, 0, GATE_ART_W, 0.5).opts.inner).toBe(gateInner(0.5))
  })

  it('faces a turret into the map', () => {
    expect(turretFace(10, 1000)).toBe(1)
    expect(turretFace(990, 1000)).toBe(-1)
    expect(turretActor(990, 0, turretFace(990, 1000)).opts.face).toBe(-1)
  })

  it('says a figure over a pickup overlaps it, and one beside it does not', () => {
    const item = [{ x: 100, y: 200 }]
    expect(overlapsAny(100, 200, 20, 40, item, 12, 16)).toBe(true)
    expect(overlapsAny(100 + 10 + 12 + 1, 200, 20, 40, item, 12, 16)).toBe(false)
    expect(overlapsAny(100, 200 + 16 + 1 + 40, 20, 40, item, 12, 16)).toBe(false)
    expect(overlapsAny(100, 200, 20, 40, [], 12, 16)).toBe(false)
  })

  it("says a figure under a pickup's label overlaps it, and one clear of it does not", () => {
    const label = [{ x0: 80, y0: 150, x1: 160, y1: 164 }]
    expect(overlapsBoxes(100, 180, 20, 40, label)).toBe(true)
    expect(overlapsBoxes(100, 150 - 1, 20, 40, label)).toBe(false)
    expect(overlapsBoxes(160 + 10 + 1, 180, 20, 40, label)).toBe(false)
  })
})
