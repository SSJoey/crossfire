import { TUNING } from '../tuning';

export interface Pos {
  x: number;
  z: number;
}

/**
 * Moves a hero one step. Shared by the server simulation and client prediction,
 * so both produce the same position for the same inputs.
 */
export function stepHero(
  p: Pos,
  moveX: number,
  moveZ: number,
  speed: number,
  dt: number,
  ring = TUNING.ring,
): void {
  const len = Math.hypot(moveX, moveZ);
  if (len > 1e-6) {
    const k = (speed * dt) / Math.max(1, len);
    p.x += moveX * k;
    p.z += moveZ * k;
  }
  constrainToArena(p, ring);
}

/** Keeps a point between the hold platform and the map edge. */
export function constrainToArena(p: Pos, ring = TUNING.ring): void {
  const d = Math.hypot(p.x, p.z);
  if (d > ring.mapRadius) {
    p.x *= ring.mapRadius / d;
    p.z *= ring.mapRadius / d;
  } else if (d < ring.holdRadius) {
    if (d < 1e-6) {
      p.x = ring.holdRadius;
      p.z = 0;
    } else {
      p.x *= ring.holdRadius / d;
      p.z *= ring.holdRadius / d;
    }
  }
}
