export interface AimTarget {
  x: number;
  z: number;
  /** False for dead or still-spawning enemies. */
  targetable: boolean;
}

/**
 * Aim assist: the index of the enemy to snap a basic attack to, or -1.
 * Considers the first `count` entries; picks the best enemy within `range`
 * and within `cone` radians of the aim direction (closest to the aim line first, then nearest).
 */
export function assistTarget(
  hx: number,
  hz: number,
  aimX: number,
  aimZ: number,
  range: number,
  cone: number,
  enemies: ArrayLike<AimTarget>,
  count: number,
): number {
  const adx = aimX - hx;
  const adz = aimZ - hz;
  if (adx * adx + adz * adz < 1e-9) return -1;
  const aimAngle = Math.atan2(adx, adz);
  const range2 = range * range;
  let best = -1;
  let bestScore = Infinity;
  const n = Math.min(count, enemies.length);
  for (let i = 0; i < n; i++) {
    const e = enemies[i]!;
    if (!e.targetable) continue;
    const dx = e.x - hx;
    const dz = e.z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 > range2) continue;
    let da = Math.atan2(dx, dz) - aimAngle;
    da = Math.abs(Math.atan2(Math.sin(da), Math.cos(da)));
    if (da > cone) continue;
    const score = da * 6 + Math.sqrt(d2) * 0.15;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
