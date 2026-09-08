/**
 * T8.03 — the F3 debug HUD (`docs/42` §8, `docs/61` §5).
 *
 * Without these numbers, netcode bugs are guesswork. That is the entire
 * justification for the task, and it is why the two that matter most —
 * **reconciliation rate** and **correction magnitude** — are on their own line
 * and are read together: a high rate of 2 px corrections is float noise, while
 * one 300 px correction is a real desync (`docs/42` §2).
 *
 * The panel is DOM (§A35). The two **ghosts** are Phaser objects on purpose:
 * they mark *world* positions, so they should scale with camera zoom, which is
 * exactly the behaviour that makes a `scrollFactor(0)` element wrong.
 */
import Phaser from 'phaser'
import { CorrectionStats, RateMeter, estimateLoss, jitterMs } from './debugHud-math'

export interface DebugHudInput {
  rttMs: number
  pendingInputs: number
  corrections: number
  lastCorrectionPx: number
  maxCorrectionPx: number
  snaps: number
  interpDepth: number
  extrapolatingMs: number
  frozen: boolean
  localPos: { x: number; y: number }
  serverPos: { x: number; y: number } | null
  checksums: { checked: number; mismatched: number; resyncs: number }
  tick: number
  serverTick: number
  clockOffsetMs: number
  seed: string
  fps: number
}

const GHOST_DEPTH = 45

export class DebugHud {
  private readonly root: HTMLPreElement
  private visible = false

  private readonly snapshotRate = new RateMeter()
  private readonly inputRate = new RateMeter()
  private readonly corrections = new CorrectionStats()
  private lastCorrectionCount = 0
  private readonly snapshotTicks: number[] = []
  private readonly snapshotArrivals: number[] = []

  private readonly localGhost: Phaser.GameObjects.Rectangle
  private readonly serverGhost: Phaser.GameObjects.Rectangle

  constructor(scene: Phaser.Scene, playerW: number, playerH: number) {
    this.root = document.createElement('pre')
    this.root.dataset.debughud = 'root'
    this.root.style.cssText = `position:fixed;left:8px;top:8px;z-index:11;margin:0;
      display:none;pointer-events:none;white-space:pre;
      font:11px/1.35 ui-monospace,monospace;color:#cfe3ff;
      background:rgba(6,10,20,0.82);border:1px solid rgba(120,160,220,0.3);
      padding:6px 8px;border-radius:3px`
    document.body.append(this.root)

    // Ghosts are world-space: the predicted body and the last server body, so
    // a divergence is *visible* rather than only a number.
    this.localGhost = scene.add
      .rectangle(0, 0, playerW, playerH)
      .setStrokeStyle(1, 0x54ff9f, 0.9)
      .setDepth(GHOST_DEPTH)
      .setVisible(false)
    this.serverGhost = scene.add
      .rectangle(0, 0, playerW, playerH)
      .setStrokeStyle(1, 0xff7a7a, 0.9)
      .setDepth(GHOST_DEPTH)
      .setVisible(false)
  }

  /** Called when a snapshot arrives, so rates describe traffic rather than frames. */
  noteSnapshot(nowMs: number, tick: number): void {
    this.snapshotRate.mark(nowMs)
    this.snapshotTicks.push(tick)
    this.snapshotArrivals.push(nowMs)
    if (this.snapshotTicks.length > 60) this.snapshotTicks.shift()
    if (this.snapshotArrivals.length > 60) this.snapshotArrivals.shift()
  }

  noteInputs(nowMs: number, count: number): void {
    this.inputRate.mark(nowMs, count)
  }

  toggle(): boolean {
    this.visible = !this.visible
    this.root.style.display = this.visible ? 'block' : 'none'
    this.localGhost.setVisible(this.visible)
    this.serverGhost.setVisible(this.visible)
    return this.visible
  }

  get isVisible(): boolean {
    return this.visible
  }

  update(nowMs: number, d: DebugHudInput): void {
    // Corrections are counted by the predictor; convert the running total into
    // windowed samples so the HUD reports the rate *now*.
    if (d.corrections > this.lastCorrectionCount) {
      for (let i = this.lastCorrectionCount; i < d.corrections; i++) {
        this.corrections.add(nowMs, d.lastCorrectionPx)
      }
      this.lastCorrectionCount = d.corrections
    }
    if (!this.visible) return

    const c = this.corrections.summary(nowMs)
    const err = d.serverPos
      ? Math.hypot(d.localPos.x - d.serverPos.x, d.localPos.y - d.serverPos.y)
      : 0
    const cs = d.checksums
    const checksum =
      cs.mismatched > 0 ? `mismatched x${cs.mismatched}` : cs.checked > 0 ? 'matched' : 'pending'

    this.root.textContent = [
      `seed ${d.seed}`,
      `fps ${d.fps.toFixed(0)}  tick ${d.tick}  server ~${d.serverTick}  offset ${d.clockOffsetMs.toFixed(0)}ms`,
      `rtt ${d.rttMs.toFixed(0)}ms  jitter ${jitterMs(this.snapshotArrivals).toFixed(1)}ms  loss~${estimateLoss(this.snapshotTicks).toFixed(1)}%`,
      `snapshots ${this.snapshotRate.perSecond(nowMs).toFixed(1)}/s  inputs ${this.inputRate.perSecond(nowMs).toFixed(1)}/s  pending ${d.pendingInputs}`,
      // The two that matter, together.
      `reconcile ${(c.count / 3).toFixed(1)}/s  mean ${c.mean.toFixed(1)}px  max ${d.maxCorrectionPx.toFixed(1)}px  snaps ${d.snaps}`,
      `interp depth ${d.interpDepth}${d.frozen ? '  FROZEN' : d.extrapolatingMs > 0 ? `  extrap ${d.extrapolatingMs.toFixed(0)}ms` : ''}`,
      `local ${d.localPos.x.toFixed(1)},${d.localPos.y.toFixed(1)}` +
        (d.serverPos
          ? `  server ${d.serverPos.x.toFixed(1)},${d.serverPos.y.toFixed(1)}  err ${err.toFixed(2)}px`
          : '  server —'),
      `mask ${checksum}  checked ${cs.checked}  resyncs ${cs.resyncs}`,
    ].join('\n')

    this.localGhost.setPosition(d.localPos.x, d.localPos.y)
    if (d.serverPos) this.serverGhost.setPosition(d.serverPos.x, d.serverPos.y)
    this.serverGhost.setVisible(this.visible && d.serverPos !== null)
  }

  /** For the e2e check: what the panel is actually showing. */
  stats(): { visible: boolean; lines: number; text: string } {
    return {
      visible: this.visible,
      lines: this.root.textContent ? this.root.textContent.split('\n').length : 0,
      text: this.root.textContent ?? '',
    }
  }

  destroy(): void {
    this.root.remove()
    this.localGhost.destroy()
    this.serverGhost.destroy()
  }
}
