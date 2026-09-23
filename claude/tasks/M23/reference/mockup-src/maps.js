// Map specs used by all variants. Coordinates are mask pixels, y down.
export const ARENA = {
  ground: [[0, 190], [250, 200], [300, 250], [335, 560], [420, 560], [470, 330], [560, 225], [640, 250], [700, 330],
    [760, 322], [840, 250], [900, 262], [950, 380], [1010, 470], [1280, 455]],
  blobs: [{ x: 1085, y: 190, rx: 110, ry: 34, noise: 0.5 }, { x: 1010, y: 215, rx: 40, ry: 26, noise: 0.6 }],
  carve: [
    { tunnel: [[560, 430], [640, 460], [760, 440], [840, 400]], r: 30 },
    { x: 1120, y: 470, r: 58 },      // fresh crater
    { x: 230, y: 330, r: 64 },       // old cave under the left cliff
    { x: 170, y: 380, r: 44 },
  ],
  scorch: [{ x: 1120, y: 470, r: 96 }],
}

export const SPACE = {
  rim: { cx: 640, cy: 180, rx: 1000, ry: 560 },
  blobs: [
    { x: 380, y: 430, rx: 230, ry: 115, noise: 0.55 },
    { x: 300, y: 350, rx: 120, ry: 70, noise: 0.6 },
    { x: 960, y: 250, rx: 170, ry: 90, noise: 0.6 },
    { x: 1080, y: 560, rx: 90, ry: 60, noise: 0.7 },
    
    { x: 650, y: 150, rx: 36, ry: 26, noise: 0.8 },
  ],
  carve: [
    { tunnel: [[250, 450], [380, 480], [500, 440]], r: 28 },
    { x: 900, y: 205, r: 46 },
    { x: 1030, y: 330, r: 40 },
  ],
  scorch: [{ x: 900, y: 205, r: 80 }],
}

// Style E: the same arena, lowered so the sky and the haze layers get room.
const lower = y => 330 + (y - 190) * 0.62
export const ARENA_E = {
  ground: ARENA.ground.map(([x, y]) => [x, lower(y)]),
  blobs: [{ x: 1085, y: 250, rx: 105, ry: 22, noise: 0.45 }, { x: 1010, y: 262, rx: 36, ry: 16, noise: 0.5 }],
  carve: [
    { tunnel: [[560, 520], [640, 540], [760, 528], [840, 505]], r: 22 },
    { x: 1120, y: 548, r: 50 },
    { x: 220, y: 430, r: 46 },
  ],
  scorch: [{ x: 1120, y: 548, r: 80 }],
}
