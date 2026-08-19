/**
 * The asset registry (docs/07 §2).
 *
 * Rendering code never names a file — it names a **texture key**, and this
 * module is the only place that maps keys to files. That is what makes
 * docs/07's promise ("assets swap in via a manifest — no rendering code
 * changes") true rather than aspirational.
 *
 * Pure and Phaser-free so it is Vitest-testable; BootScene does the loading.
 */

/** docs/07 §2: `"version": 1`. */
export const MANIFEST_VERSION = 1;

/** docs/07 §3: `{ file, frame: [x, y, w, h] }` for un-trimmed sheets. */
export type FrameRect = readonly [number, number, number, number];

/** A manifest entry: a plain path, or a frame within a sheet. */
export type AssetRef = string | { readonly file: string; readonly frame: FrameRect };

/**
 * docs/07 §2: "Placeholder mode: manifest lists `"placeholder": true` per
 * section". A section in placeholder mode names no files at all, so nothing
 * is loaded and every key in it resolves to a canvas-generated texture.
 */
export interface PlaceholderSection {
  readonly placeholder: true;
}

export type Section<T> = T | PlaceholderSection;

/** The four tile kinds, three variants each (docs/07 §2). */
export type TileKindName = 'GRASS' | 'DIRT' | 'STONE' | 'ROCK';

export interface AssetManifest {
  readonly version: number;
  readonly tiles: Section<Readonly<Record<TileKindName, readonly AssetRef[]>>>;
  readonly players: Section<readonly AssetRef[]>;
  readonly weapons: Section<Readonly<Record<string, AssetRef>>>;
  readonly items: Section<Readonly<Record<string, AssetRef>>>;
  readonly decor: Section<Readonly<Record<string, AssetRef>>>;
  readonly ui: Section<Readonly<Record<string, AssetRef>>>;
}

/** One texture to hand to Phaser's loader. */
export interface LoadEntry {
  readonly key: string;
  readonly file: string;
  readonly frame?: FrameRect;
}

export const TILE_KINDS: readonly TileKindName[] = ['GRASS', 'DIRT', 'STONE', 'ROCK'];

/** docs/07 §2: three variants per kind, selected by `(seed + x + y) % 3`. */
export const TILE_VARIANTS = 3;

/** docs/07 §4: "6 skins (player_1..6)" — keys are 0-based, matching `skin: u8`. */
export const PLAYER_SKINS = 6;

/**
 * docs/07 §4 + docs/06 §2. The manifest section key is what docs/07 §2 writes;
 * the protocol id is what `ItemId` serializes as. They disagree for the shield
 * generator — see DEVIATIONS.md D49.
 */
export const ITEM_KEYS: Readonly<Record<string, string>> = {
  medkit: 'medkit',
  overcharge: 'overcharge',
  shield: 'shield_gen',
  flashlight: 'flashlight',
};

export const WEAPON_IDS: readonly string[] = ['pistol', 'shotgun', 'rocket', 'grenade'];
export const DECOR_IDS: readonly string[] = ['bush', 'rock', 'flower'];
export const UI_IDS: readonly string[] = ['panel', 'button', 'hud_bar'];

// --- texture keys: the names rendering code uses -------------------------

export function tileTextureKey(kind: TileKindName, variant: number): string {
  return `${kind}_${variant + 1}`;
}

export function playerTextureKey(skin: number): string {
  return `player_${skin}`;
}

export function weaponTextureKey(id: string): string {
  return `weapon_${id}`;
}

/** Keyed by the PROTOCOL id (`shield_gen`), not the manifest section key. */
export function itemTextureKey(protocolId: string): string {
  return `item_${protocolId}`;
}

export function decorTextureKey(id: string): string {
  return `decor_${id}`;
}

export function uiTextureKey(id: string): string {
  return `ui_${id}`;
}

/**
 * Every texture key the renderer may ask for.
 *
 * BootScene guarantees a texture exists for each one — from the manifest if
 * the file loads, from a canvas placeholder otherwise. A key missing here is a
 * key that can render as a blank green square, which is why the list is
 * derived from the same constants the key functions use rather than typed out.
 */
export function allTextureKeys(): string[] {
  const keys: string[] = [];
  for (const kind of TILE_KINDS) {
    // The bare kind name is the pre-T5.2 key Terrain still uses.
    keys.push(kind);
    for (let v = 0; v < TILE_VARIANTS; v += 1) {
      keys.push(tileTextureKey(kind, v));
    }
  }
  for (let skin = 0; skin < PLAYER_SKINS; skin += 1) {
    keys.push(playerTextureKey(skin));
  }
  for (const id of WEAPON_IDS) {
    keys.push(weaponTextureKey(id));
  }
  for (const protocolId of Object.values(ITEM_KEYS)) {
    keys.push(itemTextureKey(protocolId));
  }
  for (const id of DECOR_IDS) {
    keys.push(decorTextureKey(id));
  }
  for (const id of UI_IDS) {
    keys.push(uiTextureKey(id));
  }
  return keys;
}

// --- manifest -> load entries -------------------------------------------

function isPlaceholder<T>(section: Section<T>): section is PlaceholderSection {
  return typeof section === 'object' && section !== null && 'placeholder' in section;
}

function entry(key: string, ref: AssetRef): LoadEntry {
  return typeof ref === 'string' ? { key, file: ref } : { key, file: ref.file, frame: ref.frame };
}

/**
 * The textures to load, in manifest order.
 *
 * A section in placeholder mode contributes nothing — docs/07 §2's escape
 * hatch, and the reason the game boots with an empty `assets/` tree.
 */
export function loadEntries(manifest: AssetManifest): LoadEntry[] {
  const entries: LoadEntry[] = [];

  if (!isPlaceholder(manifest.tiles)) {
    for (const kind of TILE_KINDS) {
      const refs = manifest.tiles[kind];
      refs.forEach((ref, index) => {
        if (index < TILE_VARIANTS) {
          entries.push(entry(tileTextureKey(kind, index), ref));
        }
      });
    }
  }
  if (!isPlaceholder(manifest.players)) {
    manifest.players.forEach((ref, index) => {
      if (index < PLAYER_SKINS) {
        entries.push(entry(playerTextureKey(index), ref));
      }
    });
  }
  if (!isPlaceholder(manifest.weapons)) {
    for (const [id, ref] of Object.entries(manifest.weapons)) {
      entries.push(entry(weaponTextureKey(id), ref));
    }
  }
  if (!isPlaceholder(manifest.items)) {
    for (const [sectionKey, ref] of Object.entries(manifest.items)) {
      entries.push(entry(itemTextureKey(ITEM_KEYS[sectionKey] ?? sectionKey), ref));
    }
  }
  if (!isPlaceholder(manifest.decor)) {
    for (const [id, ref] of Object.entries(manifest.decor)) {
      entries.push(entry(decorTextureKey(id), ref));
    }
  }
  if (!isPlaceholder(manifest.ui)) {
    for (const [id, ref] of Object.entries(manifest.ui)) {
      entries.push(entry(uiTextureKey(id), ref));
    }
  }
  return entries;
}

/**
 * Reject a manifest this loader cannot honour, rather than half-loading it.
 * Returns the reason, or null when the manifest is usable.
 */
export function manifestProblem(manifest: AssetManifest): string | null {
  if (manifest.version !== MANIFEST_VERSION) {
    return `manifest version ${manifest.version}, expected ${MANIFEST_VERSION}`;
  }
  if (!isPlaceholder(manifest.tiles)) {
    for (const kind of TILE_KINDS) {
      const refs: readonly AssetRef[] | undefined = manifest.tiles[kind];
      if (refs === undefined || refs.length !== TILE_VARIANTS) {
        // docs/07 §2's variant formula is `% 3`; a section with fewer than 3
        // entries would index past the end for some tiles and silently render
        // nothing there.
        return `tiles.${kind} must list ${TILE_VARIANTS} variants, got ${refs?.length ?? 0}`;
      }
    }
  }
  return null;
}
