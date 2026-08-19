/**
 * Building the 20 Hz input frame (T2.9 step 3, docs/06 §3).
 *
 * Pure so the send cadence and edge semantics are testable without Phaser (D10).
 */
import type { InputFrame } from '../protocol';

/** Input send rate, ms (docs/00 §2: "sends input frames at 20 Hz"). */
export const INPUT_INTERVAL_MS = 50;

/** Raw key/mouse state sampled from the browser. */
export interface RawInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  fire: boolean;
  aim: number;
  /** Slot pressed this frame, if any (keys 1–6 or the inventory UI). */
  slotPressed: number | null;
}

/**
 * Paces input frames at 20 Hz and stamps them with the tick.
 *
 * docs/06 §3: "Client sends the SAME frame every 50 ms until keys change
 * (latest-wins on server)" — so this emits on the cadence regardless of
 * whether anything changed, rather than only on change.
 */
export class InputSender {
  private lastSentAt = -Infinity;
  private tick = 0;

  /**
   * Returns a frame to send if the cadence is due, otherwise `null`.
   *
   * `slotPressed` is consumed by the frame it goes out on: docs/06 §3 says
   * `use_slot` is "null except on the tick it's pressed".
   */
  poll(now: number, raw: RawInput): InputFrame | null {
    if (now - this.lastSentAt < INPUT_INTERVAL_MS) {
      return null;
    }
    this.lastSentAt = now;
    const frame: InputFrame = {
      tick: this.tick,
      left: raw.left,
      right: raw.right,
      up: raw.up,
      down: raw.down,
      jump: raw.jump,
      aim: raw.aim,
      fire: raw.fire,
      use_slot: raw.slotPressed,
    };
    this.tick += 1;
    return frame;
  }

  /** Frames emitted so far. */
  get sentCount(): number {
    return this.tick;
  }
}
