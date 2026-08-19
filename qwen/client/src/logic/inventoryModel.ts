/**
 * Inventory panel and HUD state, derived from a snapshot (T3.9).
 *
 * Pure so Vitest can cover the slot→item mapping without Phaser (D10); the
 * panel and bars only render what this produces.
 */
import type { PlayerSnap, Six } from '../protocol';

/** Inventory slot count (docs/04 §5). */
export const SLOT_COUNT = 6;

/** Display names, keyed by the wire item id (docs/04 §1). */
export const ITEM_NAMES: Readonly<Record<string, string>> = {
  pistol: 'Pistol',
  shotgun: 'Shotgun',
  rocket: 'Rocket',
  grenade: 'Grenade',
  medkit: 'Medkit',
  overcharge: 'Overcharge',
  shield_gen: 'Shield Gen',
  flashlight: 'Flashlight',
};

/** Which items are weapons, and so show an ammo count (docs/04 §1). */
const WEAPONS = new Set(['pistol', 'shotgun', 'rocket', 'grenade']);

/** One rendered inventory slot. */
export interface SlotView {
  index: number;
  item: string | null;
  name: string;
  /** Ammo count, or null for an empty slot or a non-weapon. */
  ammo: number | null;
  selected: boolean;
  empty: boolean;
}

/** The whole HUD's state for one frame. */
export interface HudView {
  slots: SlotView[];
  health: number;
  maxHealth: number;
  /** 0..1, for the health bar width (T3.9 step 3). */
  healthFraction: number;
  shieldRemaining: number;
  shieldActive: boolean;
  jetpackFuel: number;
  /** 0..1, for the jetpack bar (5 s capacity, docs/03 §5). */
  jetpackFraction: number;
  /** Selected weapon name and ammo, or null if no weapon is selected. */
  weaponName: string | null;
  weaponAmmo: number | null;
}

/** Jetpack fuel capacity, seconds (docs/03 §5). */
export const JETPACK_FUEL_MAX = 5;

/** Build the six slot views for a player (T3.9 steps 1–2). */
export function slotViews(player: PlayerSnap): SlotView[] {
  const views: SlotView[] = [];
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const item = player.slots[index] ?? null;
    const isWeapon = item !== null && WEAPONS.has(item);
    views.push({
      index,
      item,
      name: item === null ? '' : (ITEM_NAMES[item] ?? item),
      ammo: isWeapon ? (player.ammo[index] ?? 0) : null,
      selected: player.selected === index,
      empty: item === null,
    });
  }
  return views;
}

/** Build the HUD view for the local player (T3.9 step 4). */
export function hudView(player: PlayerSnap): HudView {
  const slots = slotViews(player);
  const selected = slots[player.selected] ?? null;
  const hasWeapon = selected !== null && selected.ammo !== null;

  // Guard the divisor: a snapshot with max_health 0 would otherwise produce
  // NaN and render a bar of undefined width.
  const maxHealth = player.max_health > 0 ? player.max_health : 1;

  return {
    slots,
    health: player.health,
    maxHealth: player.max_health,
    healthFraction: clamp01(player.health / maxHealth),
    shieldRemaining: player.shield_remaining,
    shieldActive: player.shield_remaining > 0,
    jetpackFuel: player.jetpack_fuel,
    jetpackFraction: clamp01(player.jetpack_fuel / JETPACK_FUEL_MAX),
    weaponName: hasWeapon ? selected.name : null,
    weaponAmmo: hasWeapon ? selected.ammo : null,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Find the local player in a snapshot's fixed 6-entry list. */
export function localPlayer(
  players: Six<PlayerSnap>,
  id: number,
): PlayerSnap | undefined {
  return players.find((p) => p.id === id);
}
