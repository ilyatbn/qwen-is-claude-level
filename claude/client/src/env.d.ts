/**
 * The build-time flag §C17 uses to compile the dev surface out.
 *
 * Declared, not imported: `vite.config.ts` replaces it with a literal `true` or
 * `false` before the bundler runs, so every `if (__DEV_SURFACE__)` body is either
 * kept or deleted outright. There is nothing to import at runtime and nothing
 * left in the artifact to flip.
 *
 * `true` under `vite dev` and `vite build --mode e2e`; `false` in a plain
 * `vite build`. Under `vitest` it is not defined at all, which is why every use
 * site reads it through `devSurface()` in `dev.ts`.
 */
declare const __DEV_SURFACE__: boolean
