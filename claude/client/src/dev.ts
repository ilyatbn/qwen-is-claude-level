/**
 * The one place that reads §C17's build flag.
 *
 * A function rather than the bare constant, because `vitest` does not go through
 * `vite.config.ts`'s `define` and the identifier is simply not declared there —
 * a direct reference throws `__DEV_SURFACE__ is not defined` and takes the suite
 * with it. `typeof` is safe everywhere and still folds to a literal in the
 * bundle, so the dead-code elimination §C17 is asking for still happens.
 */
export function devSurface(): boolean {
  return typeof __DEV_SURFACE__ !== 'undefined' && __DEV_SURFACE__
}
