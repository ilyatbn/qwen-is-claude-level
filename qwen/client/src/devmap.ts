/**
 * Dev map generation — lets the client render ANY seed with no server (T1.10).
 *
 * This is deliberately NOT a port of the server's generator. docs/01 §3's
 * algorithm is the server's authority and duplicating it in TS would create two
 * implementations to keep in sync — exactly the drift docs/06 warns about for
 * the protocol. This produces a plausible-looking placeholder so terrain
 * rendering, the camera clamp and destruction can be exercised offline; a real
 * seeded map comes from the server via `round_started` (docs/06 §2).
 */
import {
  TILE_AIR,
  TILE_DIRT,
  TILE_GRASS,
  TILE_ROCK,
  TILE_STONE,
  type MapData,
} from './protocol';

/** Tile dimensions per scale (docs/01 §1). */
const SCALE_DIMENSIONS: Readonly<Record<string, readonly [number, number]>> = {
  small: [96, 64],
  medium: [160, 96],
  large: [240, 128],
};

/** A small deterministic PRNG, so `?seed=N` reproduces the same dev map. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Encode a tile array as base64, matching `MapData.tiles` (docs/06 §6). */
function encodeTiles(tiles: Uint8Array): string {
  let binary = '';
  for (const byte of tiles) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Build a `MapData` locally from a numeric seed.
 *
 * Surface is a sum of sines perturbed by the seeded PRNG; fill follows the
 * same depth bands as the server (docs/01 §3 step 2) so the result looks right.
 */
export function buildDevMap(seed: number, scaleName: string): MapData {
  const dims = SCALE_DIMENSIONS[scaleName] ?? SCALE_DIMENSIONS['small'];
  const [width, height] = dims as readonly [number, number];
  const random = mulberry32(seed);

  // Random phases so different seeds give visibly different terrain.
  const phaseA = random() * Math.PI * 2;
  const phaseB = random() * Math.PI * 2;
  const phaseC = random() * Math.PI * 2;

  const surface: number[] = [];
  for (let x = 0; x < width; x += 1) {
    const t = x / width;
    const wave =
      0.55 * Math.sin(t * Math.PI * 4 + phaseA) +
      0.3 * Math.sin(t * Math.PI * 9 + phaseB) +
      0.15 * Math.sin(t * Math.PI * 17 + phaseC);
    // Mirror the server's clamp band: h in [H*0.15, H*0.6] (docs/01 §3).
    const h = height * 0.35 + height * 0.22 * wave;
    const clamped = Math.min(Math.max(h, height * 0.15), height * 0.6);
    surface.push(height - 1 - Math.round(clamped));
  }

  const tiles = new Uint8Array(width * height).fill(TILE_AIR);
  for (let x = 0; x < width; x += 1) {
    const s = surface[x] ?? height - 1;
    for (let y = s; y < height; y += 1) {
      const depth = y - s;
      let kind: number;
      if (depth === 0) {
        kind = TILE_GRASS;
      } else if (depth <= 3) {
        kind = TILE_DIRT;
      } else {
        kind = TILE_STONE;
      }
      tiles[y * width + x] = kind;
    }
  }

  // A few rock pockets, so ROCK rendering is exercised offline too.
  const pocketCount = scaleName === 'large' ? 20 : scaleName === 'medium' ? 14 : 8;
  for (let i = 0; i < pocketCount; i += 1) {
    let px = Math.floor(random() * width);
    let py = (surface[px] ?? 0) + 2 + Math.floor(random() * 5);
    for (let step = 0; step < 12; step += 1) {
      if (px >= 0 && py >= 0 && px < width && py < height && py > (surface[px] ?? 0) + 1) {
        tiles[py * width + px] = TILE_ROCK;
      }
      px += Math.floor(random() * 3) - 1;
      py += Math.floor(random() * 3) - 1;
    }
  }

  return {
    seed,
    scale: scaleName,
    width,
    height,
    tiles: encodeTiles(tiles),
    decor: [],
    spawns: [],
  };
}

/** Dev options parsed from the query string (T1.9 step 4, T1.10 step 3). */
export interface DevOptions {
  seed: number;
  scale: string;
  /** `?dev=1` enables the debug camera controls. */
  dev: boolean;
}

/** Parse `?seed=N&scale=small|medium|large&dev=1`. */
export function parseDevOptions(search: string): DevOptions {
  const params = new URLSearchParams(search);
  const rawSeed = Number.parseInt(params.get('seed') ?? '', 10);
  const rawScale = params.get('scale') ?? 'small';
  return {
    seed: Number.isFinite(rawSeed) ? rawSeed : 1,
    scale: rawScale in SCALE_DIMENSIONS ? rawScale : 'small',
    dev: params.get('dev') === '1',
  };
}
