import { describe, expect, it } from 'vitest';
import { INPUT_INTERVAL_MS, InputSender, type RawInput } from './inputFrame';

const idle: RawInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
  fire: false,
  aim: 0,
  slotPressed: null,
};

describe('InputSender', () => {
  it('sends at 20 Hz (docs/00 §2)', () => {
    expect(INPUT_INTERVAL_MS).toBe(50);
  });

  it('emits the first frame immediately', () => {
    const sender = new InputSender();
    expect(sender.poll(0, idle)).not.toBeNull();
  });

  it('does not emit again before the interval elapses', () => {
    const sender = new InputSender();
    sender.poll(1000, idle);
    expect(sender.poll(1020, idle)).toBeNull();
    expect(sender.poll(1049, idle)).toBeNull();
    expect(sender.poll(1050, idle)).not.toBeNull();
  });

  it('emits roughly 20 frames per second', () => {
    const sender = new InputSender();
    for (let t = 0; t < 1000; t += 10) {
      sender.poll(t, idle);
    }
    expect(sender.sentCount).toBe(20);
  });

  it('keeps sending unchanged frames (docs/06 §3)', () => {
    // "Client sends the SAME frame every 50 ms until keys change" — the server
    // repeats the last frame on a gap, so silence is not equivalent.
    const sender = new InputSender();
    const a = sender.poll(0, idle);
    const b = sender.poll(50, idle);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b?.tick).toBe((a?.tick ?? 0) + 1);
  });

  it('increments tick per frame', () => {
    const sender = new InputSender();
    expect(sender.poll(0, idle)?.tick).toBe(0);
    expect(sender.poll(50, idle)?.tick).toBe(1);
    expect(sender.poll(100, idle)?.tick).toBe(2);
  });

  it('carries use_slot only on the frame it is pressed (docs/06 §3)', () => {
    const sender = new InputSender();
    expect(sender.poll(0, { ...idle, slotPressed: 3 })?.use_slot).toBe(3);
    expect(sender.poll(50, idle)?.use_slot).toBeNull();
  });

  it('passes key state and aim through unchanged', () => {
    const sender = new InputSender();
    const frame = sender.poll(0, {
      ...idle,
      left: true,
      jump: true,
      fire: true,
      aim: 1.25,
    });
    expect(frame?.left).toBe(true);
    expect(frame?.right).toBe(false);
    expect(frame?.jump).toBe(true);
    expect(frame?.fire).toBe(true);
    expect(frame?.aim).toBe(1.25);
  });
});
