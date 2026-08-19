/**
 * Aim geometry (T2.8, docs/03 §8, docs/06 intro).
 *
 * Pure so Vitest can test the angle convention without Phaser (D10).
 *
 * Convention (docs/06 intro): "Angles in radians, 0 = right, CCW positive
 * (client converts for mouse)." That conversion is the point of this module —
 * screen y grows DOWNWARD, so a mouse above the player has a negative dy, and
 * the naive `atan2(dy, dx)` would report clockwise-positive.
 */

/** Crosshair ring radius, px (docs/03 §8: "circle of radius 60 px"). */
export const CROSSHAIR_RADIUS = 60;

/**
 * Angle from a player to a point, in the protocol's convention.
 *
 * 0 = right, +π/2 = straight up, ±π = left, −π/2 = down.
 */
export function aimAngle(
  playerX: number,
  playerY: number,
  pointX: number,
  pointY: number,
): number {
  const dx = pointX - playerX;
  // Negated: screen y grows downward, protocol angles are CCW positive.
  const dy = -(pointY - playerY);
  return Math.atan2(dy, dx);
}

/**
 * Where the crosshair sits: on the ring, at the aim angle (docs/03 §8).
 *
 * Returned in screen coordinates, so y is negated back.
 */
export function crosshairPosition(
  playerX: number,
  playerY: number,
  angle: number,
  radius: number = CROSSHAIR_RADIUS,
): { x: number; y: number } {
  return {
    x: playerX + Math.cos(angle) * radius,
    y: playerY - Math.sin(angle) * radius,
  };
}
