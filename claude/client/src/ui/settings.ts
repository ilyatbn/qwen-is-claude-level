/**
 * Player settings that outlive a round (T21.16).
 *
 * Phaser-free and DOM-free apart from the storage handle, so the rules — which
 * are the part that can be wrong without looking wrong — are testable in node
 * (§A8). `ui/skins.ts` is the model: a picker that silently fails to save reads
 * exactly like one that saved.
 */

export const HIGH_QUALITY_KEY = 'deepcut.highQuality'

/**
 * The optional FPS counter (T21.24).
 *
 * **Not gated behind High Quality**, and deliberately a sibling key rather than
 * a second bit of the same one: its whole purpose is to let a player compare the
 * two graphics modes on their own machine, which is impossible if it only exists
 * in one of them.
 */
export const FPS_COUNTER_KEY = 'deepcut.fpsCounter'

/**
 * Read a stored boolean, defaulting to `false` on anything unexpected.
 *
 * **`localStorage` holds strings a player can edit**, so `"banana"`, `""` and a
 * missing key all have to resolve to something usable rather than to `NaN`
 * reaching a renderer. The same reasoning `skins.ts::readId` is written from,
 * and the same shape of answer.
 *
 * **The default is `false` and that is load-bearing.** Shaders only run on the
 * better graphics mode; this switch exists precisely because some machines
 * cannot. A default of `true` would make exactly those machines worse the day
 * the first shader lands.
 */
export function readFlag(store: Pick<Storage, 'getItem'>, key: string): boolean {
  try {
    return store.getItem(key) === '1'
  } catch {
    // A browser with storage disabled throws rather than returning null. That is
    // a player who gets the default, not a crash on the way into a match.
    return false
  }
}

/** Write a boolean. Swallows a storage failure for the reason `readFlag` does. */
export function writeFlag(store: Pick<Storage, 'setItem'>, key: string, on: boolean): void {
  try {
    store.setItem(key, on ? '1' : '0')
  } catch {
    /* storage disabled: the setting lasts for this session only */
  }
}

/**
 * The live value, cached so a renderer can ask per frame without touching
 * storage.
 *
 * **Not read from `localStorage` at the point of use.** A per-frame `getItem` is
 * a synchronous disk-backed call in some browsers, and a renderer that reads it
 * in a draw loop is a renderer that stutters. The menu writes; this is what
 * everything else reads.
 */
let highQuality = false
/** The FPS counter's live value, cached for the same reason (T21.24). */
let fpsCounter = false

/**
 * Load the persisted values. Call once, at boot.
 *
 * **Every setting has to be read here.** T21.16 shipped one that was not, and
 * its gate passed because nothing consumed the value yet — so a stored `on`
 * silently reverted to `off` on every reload and nothing in the repository could
 * say so. `fps-counter.mjs` reloads the page and photographs the counter for
 * exactly this reason.
 */
export function loadSettings(store: Pick<Storage, 'getItem'>): void {
  highQuality = readFlag(store, HIGH_QUALITY_KEY)
  fpsCounter = readFlag(store, FPS_COUNTER_KEY)
}

/**
 * Is High Quality on?
 *
 * **The one accessor every renderer uses.** A second source of this answer is a
 * second thing that can disagree — the shape this project keeps paying for.
 */
export function isHighQuality(): boolean {
  return highQuality
}

/**
 * Set it, persist it, and tell whoever is listening.
 *
 * Returns the value actually in force, read back rather than echoed: a setter
 * that answers with its own argument cannot report a storage failure.
 */
export function setHighQuality(store: Pick<Storage, 'setItem'>, on: boolean): boolean {
  highQuality = on
  writeFlag(store, HIGH_QUALITY_KEY, on)
  for (const fn of listeners) fn(highQuality)
  return highQuality
}

type Listener = (on: boolean) => void
const listeners = new Set<Listener>()

/**
 * Be told when the setting changes.
 *
 * **The toggle has to be live.** A setting that needs a restart to take effect is
 * one the player flips, sees nothing, and flips back. Layers that were built
 * under the old value subscribe here and rebuild.
 */
export function onHighQualityChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Is the FPS counter on? (T21.24)
 *
 * Same shape as `isHighQuality`, same reason: one accessor, so the HUD and the
 * options panel cannot hold two answers to one question.
 */
export function isFpsCounter(): boolean {
  return fpsCounter
}

/** Set it, persist it, tell listeners, and answer with the value in force. */
export function setFpsCounter(store: Pick<Storage, 'setItem'>, on: boolean): boolean {
  fpsCounter = on
  writeFlag(store, FPS_COUNTER_KEY, on)
  for (const fn of fpsListeners) fn(fpsCounter)
  return fpsCounter
}

/**
 * Be told when the FPS counter is switched on or off.
 *
 * **Its own listener set**, not a shared one carrying a name: a single set would
 * wake the fog layer every time somebody toggled a text readout, and a listener
 * that has to ask "which setting was that?" is the field-means-two-things bug in
 * advance.
 */
export function onFpsCounterChange(fn: Listener): () => void {
  fpsListeners.add(fn)
  return () => fpsListeners.delete(fn)
}

const fpsListeners = new Set<Listener>()

/** Test seam: forget everything, so a suite can exercise the empty path. */
export function resetSettingsForTest(): void {
  highQuality = false
  fpsCounter = false
  listeners.clear()
  fpsListeners.clear()
}
