import { describe, expect, it } from 'vitest';
import { clampCamera } from './camera';

// Small map: 96x64 tiles at 16 px = 1536x1024 (docs/01 §1).
const MAP_W = 1536;
const MAP_H = 1024;
const VIEW_W = 800;
const VIEW_H = 600;

describe('clampCamera (T1.10 step 1)', () => {
  it('leaves an in-bounds position alone', () => {
    expect(clampCamera(300, 200, VIEW_W, VIEW_H, MAP_W, MAP_H)).toEqual({
      x: 300,
      y: 200,
    });
  });

  it('clamps at the left and top edges', () => {
    expect(clampCamera(-500, -500, VIEW_W, VIEW_H, MAP_W, MAP_H)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('clamps at the right and bottom edges', () => {
    expect(clampCamera(99999, 99999, VIEW_W, VIEW_H, MAP_W, MAP_H)).toEqual({
      x: MAP_W - VIEW_W,
      y: MAP_H - VIEW_H,
    });
  });

  it('never shows anything outside the map', () => {
    for (const [sx, sy] of [
      [-9999, -9999],
      [0, 0],
      [700, 400],
      [9999, 9999],
    ]) {
      const c = clampCamera(sx as number, sy as number, VIEW_W, VIEW_H, MAP_W, MAP_H);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + VIEW_W).toBeLessThanOrEqual(MAP_W);
      expect(c.y + VIEW_H).toBeLessThanOrEqual(MAP_H);
    }
  });

  it('centres the map when the viewport is larger than it', () => {
    // A window wider than a Small map should not jam the map to the left.
    expect(clampCamera(0, 0, 2000, 1200, MAP_W, MAP_H)).toEqual({
      x: (MAP_W - 2000) / 2,
      y: (MAP_H - 1200) / 2,
    });
  });
});
