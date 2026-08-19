/**
 * Persisted lobby choices (docs/07 §4: "stored in `localStorage["skin"]`").
 *
 * Split out of LobbyScene so T5.3's Acceptance — "refresh page → same skin
 * restored from localStorage" — is a unit test rather than a manual click.
 */

/** The part of `Storage` this needs; lets tests pass a plain object. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A stored 0-based index, or 0 when absent, unparseable, or out of range for
 * this build. Out-of-range falls back rather than clamping: a stored `9` from
 * a future build with more skins should show skin 0, not skin 5.
 */
export function storedIndex(store: KeyValueStore, key: string, count: number): number {
  const raw = store.getItem(key);
  if (raw === null) {
    return 0;
  }
  // Strict digits only: `parseInt` would read "3.5.1" as 3 and turn corrupt
  // storage into a valid-looking choice.
  if (!/^\d+$/.test(raw)) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed < count ? parsed : 0;
}

/** Persist a choice, ignoring values this build cannot render. */
export function storeIndex(
  store: KeyValueStore,
  key: string,
  value: number,
  count: number,
): boolean {
  if (!Number.isInteger(value) || value < 0 || value >= count) {
    return false;
  }
  store.setItem(key, String(value));
  return true;
}
