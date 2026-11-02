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
