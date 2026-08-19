/**
 * T3.9 step 5: "panel slot->item mapping from a fixture snapshot".
 * Pure logic only — no Phaser (D10).
 */
import { describe, expect, it } from 'vitest';
import {
  hudView,
  JETPACK_FUEL_MAX,
  localPlayer,
  SLOT_COUNT,
  slotViews,
} from './inventoryModel';
import type { PlayerSnap, Six } from '../protocol';

function player(overrides: Partial<PlayerSnap> = {}): PlayerSnap {
  return {
    id: 0,
    name: 'p0',
    skin: 0,
    x: 0,
    y: 0,
    facing: 0,
    health: 100,
    max_health: 100,
    shield_remaining: 0,
    jetpack_fuel: 5,
    fov: 420,
    alive: true,
    respawn_in_s: 0,
    score: 0,
    slots: ['pistol', 'medkit', null, 'rocket', null, 'flashlight'],
    selected: 0,
    ammo: [30, 0, 0, 6, 0, 0],
    ...overrides,
  };
}

describe('slotViews', () => {
  it('always produces six slots (docs/04 §5)', () => {
    expect(slotViews(player())).toHaveLength(SLOT_COUNT);
    expect(SLOT_COUNT).toBe(6);
  });

  it('maps each slot to its item and display name', () => {
    const views = slotViews(player());
    expect(views[0]?.item).toBe('pistol');
    expect(views[0]?.name).toBe('Pistol');
    expect(views[3]?.item).toBe('rocket');
    expect(views[3]?.name).toBe('Rocket');
    expect(views[5]?.name).toBe('Flashlight');
  });

  it('marks empty slots and gives them no ammo', () => {
    const views = slotViews(player());
    expect(views[2]?.empty).toBe(true);
    expect(views[2]?.item).toBeNull();
    expect(views[2]?.ammo).toBeNull();
    expect(views[0]?.empty).toBe(false);
  });

  it('shows ammo for weapons only', () => {
    const views = slotViews(player());
    expect(views[0]?.ammo).toBe(30); // pistol
    expect(views[3]?.ammo).toBe(6); // rocket
    expect(views[1]?.ammo).toBeNull(); // medkit is not a weapon
    expect(views[5]?.ammo).toBeNull(); // flashlight is not a weapon
  });

  it('marks exactly one slot selected', () => {
    const views = slotViews(player({ selected: 3 }));
    expect(views.filter((v) => v.selected).map((v) => v.index)).toEqual([3]);
  });

  it('uses the wire id as a fallback name for an unknown item', () => {
    const views = slotViews(
      player({ slots: ['mystery', null, null, null, null, null] }),
    );
    expect(views[0]?.name).toBe('mystery');
  });
});

describe('hudView', () => {
  it('reports health as a fraction for the bar (T3.9 step 3)', () => {
    expect(hudView(player({ health: 50 })).healthFraction).toBeCloseTo(0.5, 6);
    expect(hudView(player({ health: 100 })).healthFraction).toBeCloseTo(1, 6);
    expect(hudView(player({ health: 0 })).healthFraction).toBe(0);
  });

  it('scales the health bar to max_health, not to 100', () => {
    // While overcharged max_health is 150 (docs/03 §6), so 150 hp is a FULL
    // bar, not a 1.5x overflowing one.
    const view = hudView(player({ health: 150, max_health: 150 }));
    expect(view.healthFraction).toBeCloseTo(1, 6);
    expect(hudView(player({ health: 75, max_health: 150 })).healthFraction).toBeCloseTo(0.5, 6);
  });

  it('never produces NaN or an out-of-range fraction', () => {
    // A malformed snapshot must not render a bar of undefined width.
    expect(hudView(player({ health: 100, max_health: 0 })).healthFraction).toBe(1);
    expect(hudView(player({ health: -20 })).healthFraction).toBe(0);
    expect(hudView(player({ health: 999 })).healthFraction).toBe(1);
    expect(hudView(player({ jetpack_fuel: 99 })).jetpackFraction).toBe(1);
    expect(hudView(player({ jetpack_fuel: -1 })).jetpackFraction).toBe(0);

    // A non-finite value must clamp to 0, not propagate. The max_health
    // divisor is separately guarded, so this is the only path that reaches
    // the isFinite check — without this case, removing that check failed
    // zero tests.
    expect(hudView(player({ jetpack_fuel: Number.NaN })).jetpackFraction).toBe(0);
    // Infinity is not finite either, so it clamps to 0 rather than to 1 —
    // a full bar would be a worse lie than an empty one for a bad snapshot.
    expect(hudView(player({ jetpack_fuel: Number.POSITIVE_INFINITY })).jetpackFraction).toBe(0);
    expect(hudView(player({ health: Number.NaN })).healthFraction).toBe(0);
  });

  it('reports the jetpack fuel against the documented 5 s capacity', () => {
    expect(JETPACK_FUEL_MAX).toBe(5);
    expect(hudView(player({ jetpack_fuel: 2.5 })).jetpackFraction).toBeCloseTo(0.5, 6);
    expect(hudView(player({ jetpack_fuel: 5 })).jetpackFraction).toBeCloseTo(1, 6);
  });

  it('reports shield state from the remaining time', () => {
    expect(hudView(player({ shield_remaining: 0 })).shieldActive).toBe(false);
    const shielded = hudView(player({ shield_remaining: 12.5 }));
    expect(shielded.shieldActive).toBe(true);
    expect(shielded.shieldRemaining).toBe(12.5);
  });

  it('shows the selected weapon name and ammo', () => {
    const view = hudView(player({ selected: 3 }));
    expect(view.weaponName).toBe('Rocket');
    expect(view.weaponAmmo).toBe(6);
  });

  it('shows no weapon when a consumable or empty slot is selected', () => {
    // Selecting a medkit slot uses it (docs/04 §5); the HUD should not claim
    // a weapon is equipped.
    const consumable = hudView(player({ selected: 1 }));
    expect(consumable.weaponName).toBeNull();
    expect(consumable.weaponAmmo).toBeNull();

    const empty = hudView(player({ selected: 2 }));
    expect(empty.weaponName).toBeNull();
  });

  it('survives a selected index past the end', () => {
    const view = hudView(player({ selected: 99 }));
    expect(view.weaponName).toBeNull();
    expect(view.slots).toHaveLength(6);
  });
});

describe('localPlayer', () => {
  it('finds a player by id in the fixed six-entry list', () => {
    const players = [
      player({ id: 0 }),
      player({ id: 1, name: 'p1' }),
      player({ id: 2 }),
      player({ id: 3 }),
      player({ id: 4 }),
      player({ id: 5 }),
    ] as Six<PlayerSnap>;
    expect(localPlayer(players, 1)?.name).toBe('p1');
    expect(localPlayer(players, 9)).toBeUndefined();
  });
});
