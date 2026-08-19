/**
 * Canvas-generated stand-ins for every texture key (docs/07 §5).
 *
 * docs/07 §2 promises the game "never breaks on a missing asset". That is only
 * true if a placeholder exists for **every** key the renderer can ask for, so
 * these specs are derived from the same key functions the manifest loader uses
 * — `placeholders.test.ts` fails if a key exists with no spec.
 *
 * Pure data: the drawing happens in BootScene, which owns the canvas.
 */
import {
  DECOR_IDS,
  ITEM_KEYS,
  PLAYER_SKINS,
  TILE_KINDS,
  TILE_VARIANTS,
  UI_IDS,
  WEAPON_IDS,
  decorTextureKey,
  itemTextureKey,
  playerTextureKey,
  tileTextureKey,
  uiTextureKey,
  weaponTextureKey,
  type TileKindName,
} from './manifest';
import { TILE_SIZE } from '../logic/terrainGrid';

export interface PlaceholderSpec {
  readonly shape: 'rect' | 'circle';
  readonly width: number;
  readonly height: number;
  readonly colour: number;
  /** Tiles get a darker edge so neighbours of one kind stay distinguishable. */
  readonly edge?: boolean;
}

/** docs/07 §5, verbatim. */
export const PLACEHOLDER_TILE_COLOURS: Readonly<Record<TileKindName, number>> = {
  GRASS: 0x4a8f3c,
  DIRT: 0x7a5230,
  STONE: 0x6b6b6b,
  ROCK: 0x8a7f6a,
};

/** docs/07 §5: "24×28 rect, color per player id (6 fixed colors)". */
export const PLAYER_COLOURS: readonly number[] = [
  0xe6194b, 0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4, 0x42d4f4,
];

/** docs/07 §5: "12×12 circle, color per item kind". Keyed by protocol id. */
const ITEM_COLOURS: Readonly<Record<string, number>> = {
  medkit: 0xff5555,
  overcharge: 0xffd93d,
  shield_gen: 0x4fc3f7,
  flashlight: 0xfff3b0,
};

const DECOR_COLOURS: Readonly<Record<string, number>> = {
  bush: 0x2f6b2a,
  rock: 0x7d7d7d,
  flower: 0xd46aa8,
};

/** docs/07 §5 gives no UI placeholder — see DEVIATIONS.md D50. */
const UI_COLOURS: Readonly<Record<string, number>> = {
  panel: 0x1c1c22,
  button: 0x33333d,
  hud_bar: 0x22c55e,
};

export const PLAYER_BODY = { width: 24, height: 28 } as const;
export const WEAPON_STUB = { width: 10, height: 4 } as const;
export const ITEM_DIAMETER = 12;

function build(): Map<string, PlaceholderSpec> {
  const specs = new Map<string, PlaceholderSpec>();
  const tile = (colour: number): PlaceholderSpec => ({
    shape: 'rect', width: TILE_SIZE, height: TILE_SIZE, colour, edge: true,
  });

  for (const kind of TILE_KINDS) {
    const colour = PLACEHOLDER_TILE_COLOURS[kind];
    specs.set(kind, tile(colour));
    for (let v = 0; v < TILE_VARIANTS; v += 1) {
      specs.set(tileTextureKey(kind, v), tile(colour));
    }
  }
  for (let skin = 0; skin < PLAYER_SKINS; skin += 1) {
    specs.set(playerTextureKey(skin), {
      shape: 'rect',
      width: PLAYER_BODY.width,
      height: PLAYER_BODY.height,
      colour: PLAYER_COLOURS[skin % PLAYER_COLOURS.length] ?? 0xffffff,
    });
  }
  for (const id of WEAPON_IDS) {
    specs.set(weaponTextureKey(id), {
      shape: 'rect', width: WEAPON_STUB.width, height: WEAPON_STUB.height, colour: 0x222222,
    });
  }
  for (const protocolId of Object.values(ITEM_KEYS)) {
    specs.set(itemTextureKey(protocolId), {
      shape: 'circle',
      width: ITEM_DIAMETER,
      height: ITEM_DIAMETER,
      colour: ITEM_COLOURS[protocolId] ?? 0xffffff,
    });
  }
  for (const id of DECOR_IDS) {
    specs.set(decorTextureKey(id), {
      shape: 'rect', width: TILE_SIZE, height: TILE_SIZE, colour: DECOR_COLOURS[id] ?? 0x888888,
    });
  }
  for (const id of UI_IDS) {
    specs.set(uiTextureKey(id), {
      shape: 'rect', width: 32, height: 8, colour: UI_COLOURS[id] ?? 0x444444,
    });
  }
  return specs;
}

export const PLACEHOLDER_SPECS: ReadonlyMap<string, PlaceholderSpec> = build();

export function placeholderFor(key: string): PlaceholderSpec | undefined {
  return PLACEHOLDER_SPECS.get(key);
}
