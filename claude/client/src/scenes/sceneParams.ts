/**
 * The map-generation parameters the two dev scenes take from their URL, in one
 * place (`M22-RULINGS` R22).
 *
 * `SandboxScene` and `PreviewScene` both read `?gravity=` and both fall back to
 * the default map when the spelling is one this build does not know. That was
 * two copies of the same three lines, and it was **two copies with no test
 * behind either**: deleting `params.get('gravity')` from both scenes turned
 * nothing red, because a Phaser scene cannot be constructed under vitest and no
 * browser check passed the parameter. Here it is one copy, it is pure, and
 * `sceneParams.test.ts` is red the moment the parameter stops being read.
 */
import { DEFAULT_MAP_GENERATOR, type MapGenerator, type MapScale } from '../core'

/**
 * The gravity a dev scene runs under when the URL does not say.
 *
 * A wire spelling rather than an enum because that is what `generateForGravity`
 * and `Core.setGravity` both take, and parsing it in two places is how a
 * spelling drifts. `core/index.test.ts` asserts this particular one is a
 * spelling `GravityMode::parse` accepts, so a typo here cannot ship as a silent
 * fallback to the default map.
 */
export const DEFAULT_GRAVITY = 'standard'

/** `?gravity=space`, or the default when it is absent. */
export function gravityFromUrl(params: URLSearchParams): string {
  return params.get('gravity') ?? DEFAULT_GRAVITY
}

/**
 * What a dev scene needs of `Core` in order to build a map.
 *
 * Narrow on purpose: it lets the test below drive `generateForScene` without a
 * wasm module, so the fallback branch is exercised rather than argued about.
 */
export interface GeneratesMaps {
  generateForGravity(
    seed: bigint,
    scale: MapScale,
    generator: MapGenerator,
    gravity: string,
  ): boolean
  generate(seed: bigint, scale: MapScale): void
}

/**
 * Generate **through the gravity**, because the gravity decides the generator
 * (R15) — and fall back to the default map if the spelling is unknown.
 *
 * `generateForGravity` returning false generates nothing (refuse rather than
 * clamp, §E6), so without the fallback a dev scene would be left rendering
 * whatever map was there before, which reads as the parameter having worked.
 */
export function generateForScene(
  core: GeneratesMaps,
  seed: bigint,
  scale: MapScale,
  gravity: string,
): void {
  if (!core.generateForGravity(seed, scale, DEFAULT_MAP_GENERATOR, gravity)) {
    core.generate(seed, scale)
  }
}
