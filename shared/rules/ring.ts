import { TUNING } from '../tuning';
import type { HeroStatus } from '../types';
import { applyDamage, applyHeal } from './health';

/** Strictly outside: a hero exactly on the edge counts as inside. */
export function isOutsideRing(x: number, z: number, radius = TUNING.ring.radius): boolean {
  return x * x + z * z > radius * radius;
}

/**
 * HP after one step of the soft edge: drain outside the ring, regen inside.
 * Downed and dead heroes are unaffected. Reaching 0 is allowed; the caller decides "downed".
 */
export function ringHealth(
  hp: number,
  maxHp: number,
  x: number,
  z: number,
  dt: number,
  status: HeroStatus,
  ring = TUNING.ring,
): number {
  if (status !== 'standing') return hp;
  if (isOutsideRing(x, z, ring.radius)) return applyDamage(hp, ring.drainPerSec * dt);
  return applyHeal(hp, ring.regenPerSec * dt, maxHp);
}
