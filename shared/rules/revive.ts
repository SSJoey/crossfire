import { TUNING } from '../tuning';
import type { HeroStatus } from '../types';

/** The fields the revive rules read and write. Server heroes carry these. */
export interface ReviveHero {
  id: string;
  x: number;
  z: number;
  status: HeroStatus;
  hp: number;
  maxHp: number;
  /** Seconds left before a downed hero dies. */
  bleedOut: number;
  /** Seconds of revive collected on this hero's body. */
  reviveProgress: number;
  /** The player holds F. */
  holdingRevive: boolean;
}

/** A standing hero at 0 HP goes down. Returns true when it just went down. */
export function downIfDepleted(h: ReviveHero, t = TUNING.revive): boolean {
  if (h.status !== 'standing' || h.hp > 0) return false;
  h.status = 'downed';
  h.hp = 0;
  h.bleedOut = t.bleedOutSec;
  h.reviveProgress = 0;
  return true;
}

// Reused between calls: index of the body each hero is reviving (-1 for none).
let targetOf: number[] = [];

/**
 * One step of downed and dead heroes.
 * - Each standing hero holding F works on the nearest body (downed or dead) within the radius.
 * - Downed: one helper is enough; progress resets when nobody helps; bleeds out to dead.
 * - Dead: every standing hero must be helping this body; progress pauses otherwise.
 * Mutates the heroes in place.
 */
export function stepRevive(heroes: readonly ReviveHero[], dt: number, t = TUNING.revive): void {
  const n = heroes.length;
  if (targetOf.length < n) targetOf = new Array<number>(n);
  const r2 = t.radius * t.radius;
  let standing = 0;

  for (let i = 0; i < n; i++) {
    targetOf[i] = -1;
    const h = heroes[i]!;
    if (h.status !== 'standing') continue;
    standing++;
    if (!h.holdingRevive) continue;
    let best = -1;
    let bestD2 = r2;
    for (let j = 0; j < n; j++) {
      const b = heroes[j]!;
      if (b.status === 'standing') continue;
      const dx = b.x - h.x;
      const dz = b.z - h.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = j;
      }
    }
    targetOf[i] = best;
  }

  for (let j = 0; j < n; j++) {
    const b = heroes[j]!;
    if (b.status === 'standing') continue;
    let helpers = 0;
    for (let i = 0; i < n; i++) if (targetOf[i] === j) helpers++;

    if (b.status === 'downed') {
      if (helpers > 0) {
        b.reviveProgress += dt;
        if (b.reviveProgress >= t.downedReviveSec - 1e-9) {
          standUp(b, t.downedReviveHpFrac);
          continue;
        }
      } else {
        b.reviveProgress = 0;
      }
      b.bleedOut -= dt;
      if (b.bleedOut <= 1e-9) {
        b.status = 'dead';
        b.hp = 0;
        b.bleedOut = 0;
        b.reviveProgress = 0;
      }
    } else if (standing > 0 && helpers === standing) {
      b.reviveProgress += dt;
      if (b.reviveProgress >= t.deadReviveSec - 1e-9) standUp(b, t.deadReviveHpFrac);
    }
  }
}

function standUp(b: ReviveHero, hpFrac: number): void {
  b.status = 'standing';
  b.hp = b.maxHp * hpFrac;
  b.bleedOut = 0;
  b.reviveProgress = 0;
}
