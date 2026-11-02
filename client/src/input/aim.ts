/**
 * Where a ray from (ox, oy, oz) along (dx, dy, dz) meets the ground (y = 0).
 * Writes into `out` and returns true; returns false (leaving `out` alone) when the ray is
 * parallel to the ground or points away from it.
 */
export function rayToGround(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  out: { x: number; z: number },
): boolean {
  if (dy > -1e-6) return false;
  const t = -oy / dy;
  if (t < 0) return false;
  out.x = ox + dx * t;
  out.z = oz + dz * t;
  return true;
}

/** Pulls a point back inside the map circle. */
export function clampToMap(out: { x: number; z: number }, radius: number): void {
  const d = Math.hypot(out.x, out.z);
  if (d > radius) {
    out.x *= radius / d;
    out.z *= radius / d;
  }
}
