import type { Tuning } from '@crossfire/shared/tuning';
import { enemyStats } from '@crossfire/shared/rules/scaling';

export type EnemyState = 'spawning' | 'moving' | 'winding';

export interface SimEnemy {
  /** Stable id for the client (indices change when the pool compacts). */
  uid: number;
  x: number;
  z: number;
  facing: number;
  hp: number;
  maxHp: number;
  level: number;
  damage: number;
  speed: number;
  scale: number;
  radius: number;
  state: EnemyState;
  /** Seconds left in the current spawning or wind-up state. */
  timer: number;
  swingCd: number;
  targetId: string | null;
  /** Read by aim assist: false while spawning or dead. */
  targetable: boolean;
  /** Stun time left: no walking, no swings (s). */
  stunT: number;
  /** Burn (Kindle): time left and damage per second. */
  burnT: number;
  burnDps: number;
  /** Slow from a zone (refreshed while inside) and from a bolt (Undertow); the strongest wins. */
  zoneSlowFrac: number;
  zoneSlowT: number;
  boltSlowFrac: number;
  boltSlowT: number;
  /** Taunt (Stone skin): the hero this enemy must target, and for how long. */
  tauntId: string | null;
  tauntT: number;
  /** Knockback velocity, decaying (m/s). */
  kvx: number;
  kvz: number;
  /** The last Gust dash that knocked this enemy (each dash knocks it once). */
  dashHitId: number;
}

function blank(): SimEnemy {
  return {
    uid: 0,
    x: 0,
    z: 0,
    facing: 0,
    hp: 0,
    maxHp: 0,
    level: 1,
    damage: 0,
    speed: 0,
    scale: 1,
    radius: 0,
    state: 'spawning',
    timer: 0,
    swingCd: 0,
    targetId: null,
    targetable: false,
    stunT: 0,
    burnT: 0,
    burnDps: 0,
    zoneSlowFrac: 0,
    zoneSlowT: 0,
    boltSlowFrac: 0,
    boltSlowT: 0,
    tauntId: null,
    tauntT: 0,
    kvx: 0,
    kvz: 0,
    dashHitId: 0,
  };
}

/** Fixed-size pool. Active enemies are items[0..count); release swaps with the last. */
export class EnemyPool {
  readonly items: SimEnemy[];
  count = 0;
  private nextUid = 1;

  constructor(readonly capacity: number) {
    this.items = Array.from({ length: capacity }, blank);
  }

  spawn(x: number, z: number, level: number, t: Tuning): SimEnemy | null {
    if (this.count >= this.capacity) return null;
    const e = this.items[this.count++]!;
    const s = enemyStats(level, t.minion);
    e.uid = this.nextUid++;
    e.x = x;
    e.z = z;
    e.facing = Math.atan2(-x, -z);
    e.hp = s.maxHp;
    e.maxHp = s.maxHp;
    e.level = level;
    e.damage = s.damage;
    e.speed = s.speed;
    e.scale = s.scale;
    e.radius = t.minion.radius * s.scale;
    e.state = 'spawning';
    e.timer = t.minion.spawnSec;
    e.swingCd = 0;
    e.targetId = null;
    e.targetable = false;
    e.stunT = 0;
    e.burnT = 0;
    e.burnDps = 0;
    e.zoneSlowFrac = 0;
    e.zoneSlowT = 0;
    e.boltSlowFrac = 0;
    e.boltSlowT = 0;
    e.tauntId = null;
    e.tauntT = 0;
    e.kvx = 0;
    e.kvz = 0;
    e.dashHitId = 0;
    return e;
  }

  release(i: number): void {
    if (i < 0 || i >= this.count) return;
    const last = this.count - 1;
    if (i !== last) {
      const tmp = this.items[i]!;
      this.items[i] = this.items[last]!;
      this.items[last] = tmp;
    }
    this.count--;
  }

  clear(): void {
    this.count = 0;
  }
}
