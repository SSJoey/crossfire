import type { HeroId } from '../heroes';
import { TUNING, type Tuning } from '../tuning';
import type { HeroStatus } from '../types';
import { constrainToArena, type Pos } from './movement';

/** A cast (Q or E) needs a standing hero whose cooldown has run out. */
export function canCast(status: HeroStatus, cooldown: number): boolean {
  return status === 'standing' && cooldown <= 1e-9;
}

/** Where a Q zone lands: the aim point, pulled back along the aim line to at most `range`. */
export function clampCast(hx: number, hz: number, ax: number, az: number, range: number, out: Pos): void {
  const dx = ax - hx;
  const dz = az - hz;
  const d = Math.hypot(dx, dz);
  if (d > range) {
    out.x = hx + (dx / d) * range;
    out.z = hz + (dz / d) * range;
  } else {
    out.x = ax;
    out.z = az;
  }
}

/** Flame step: the aim point, at most `range` away, kept inside the arena. */
export function blinkTarget(
  hx: number,
  hz: number,
  ax: number,
  az: number,
  range: number,
  out: Pos,
  ring = TUNING.ring,
): void {
  clampCast(hx, hz, ax, az, range, out);
  constrainToArena(out, ring);
}

/** One tick of Gust dash along a unit direction. Shared by the server and own-hero prediction. */
export function dashStep(
  p: Pos,
  dirX: number,
  dirZ: number,
  speed: number,
  dt: number,
  ring = TUNING.ring,
): void {
  p.x += dirX * speed * dt;
  p.z += dirZ * speed * dt;
  constrainToArena(p, ring);
}

/** Damage a hero actually takes: Bastion's Steadfast always, Stone skin while it lasts. */
export function damageTaken(amount: number, hero: HeroId, stoneSkin: boolean, t: Tuning = TUNING): number {
  if (hero !== 'bastion') return amount;
  const b = t.heroes.bastion;
  return amount * b.passive.damageTakenMul * (stoneSkin ? b.utility.damageTakenMul : 1);
}

/** HP after a Mending wave: +`frac` of max HP, never above max. */
export function healed(hp: number, maxHp: number, frac: number): number {
  return Math.min(maxHp, hp + maxHp * frac);
}

/** The slow an enemy moves with: the strongest of its active slows (a timer ≤ 0 is inactive). */
export function strongestSlow(zoneFrac: number, zoneT: number, boltFrac: number, boltT: number): number {
  return Math.max(zoneT > 0 ? zoneFrac : 0, boltT > 0 ? boltFrac : 0);
}

/**
 * Tailwind bookkeeping for one swing that hit something. `count` is the hits before it.
 * Writes the new count and this swing's damage multiplier into `out`.
 */
export function tailwindHit(
  count: number,
  every: number,
  mult: number,
  out: { count: number; mult: number },
): void {
  const n = count + 1;
  if (n >= every) {
    out.count = 0;
    out.mult = mult;
  } else {
    out.count = n;
    out.mult = 1;
  }
}

export interface MeleeTarget {
  x: number;
  z: number;
  targetable: boolean;
  hp: number;
}

/**
 * Indices of the enemies a melee swing hits: risen and alive, centre within
 * reach + extraReach, inside the front arc around (fx, fz) (a unit vector).
 * Writes them into `out` (preallocated) and returns how many.
 */
export function meleeHits(
  hx: number,
  hz: number,
  fx: number,
  fz: number,
  reach: number,
  enemies: ArrayLike<MeleeTarget>,
  count: number,
  out: Int32Array,
  m = TUNING.melee,
): number {
  const r = reach + m.extraReach;
  const r2 = r * r;
  let n = 0;
  const len = Math.min(count, enemies.length);
  for (let i = 0; i < len && n < out.length; i++) {
    const e = enemies[i]!;
    if (!e.targetable || e.hp <= 0) continue;
    const dx = e.x - hx;
    const dz = e.z - hz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    const d = Math.sqrt(d2);
    if (d > 1e-6 && (dx * fx + dz * fz) / d < m.arcCos) continue;
    out[n++] = i;
  }
  return n;
}
