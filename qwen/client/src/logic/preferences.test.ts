import { describe, expect, it } from 'vitest';
import { storeIndex, storedIndex, type KeyValueStore } from './preferences';

const store = (initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

describe('storedIndex', () => {
  /** T5.3 Acceptance: "refresh page → same skin restored from localStorage". */
  it('restores a stored choice', () => {
    expect(storedIndex(store({ skin: '4' }), 'skin', 6)).toBe(4);
  });

  it('defaults to 0 when nothing is stored', () => {
    expect(storedIndex(store(), 'skin', 6)).toBe(0);
  });

  it.each(['', 'x', '-1', '6', '3.5.1', 'NaN'])('defaults to 0 for %o', (raw) => {
    expect(storedIndex(store({ skin: raw }), 'skin', 6)).toBe(0);
  });

  it('falls back rather than clamping an index from a build with more skins', () => {
    // Clamping would show skin 5 and look deliberate; 0 looks like a default.
    expect(storedIndex(store({ skin: '9' }), 'skin', 6)).toBe(0);
  });

  it('handles the 2-value weapon skin range (docs/07 §4: "v1: 0/1")', () => {
    expect(storedIndex(store({ weapon_skin: '1' }), 'weapon_skin', 2)).toBe(1);
    expect(storedIndex(store({ weapon_skin: '2' }), 'weapon_skin', 2)).toBe(0);
  });
});

describe('storeIndex', () => {
  it('persists a valid choice', () => {
    const s = store();
    expect(storeIndex(s, 'skin', 3, 6)).toBe(true);
    expect(s.data['skin']).toBe('3');
    expect(storedIndex(s, 'skin', 6)).toBe(3);
  });

  it('refuses a value this build cannot render', () => {
    const s = store();
    expect(storeIndex(s, 'skin', 6, 6)).toBe(false);
    expect(s.data['skin']).toBeUndefined();
  });
});
