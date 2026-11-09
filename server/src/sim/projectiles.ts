import type { HeroId } from '@crossfire/shared/heroes';

export interface SimProjectile {
  uid: number;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  travelled: number;
  range: number;
  speed: number;
  damage: number;
  hitRadius: number;
  ownerId: string;
  /** The owner's hero when it fired (decides Kindle or Undertow, even if the owner switches). */
  kit: HeroId;
}

function blank(): SimProjectile {
  return {
    uid: 0,
    x: 0,
    z: 0,
    dirX: 0,
    dirZ: 1,
    travelled: 0,
    range: 0,
    speed: 0,
    damage: 0,
    hitRadius: 0,
    ownerId: '',
    kit: 'ember',
  };
}

/** Fixed-size pool of bolts (points). Active ones are items[0..count). */
export class ProjectilePool {
  readonly items: SimProjectile[];
  count = 0;
  private nextUid = 1;

  constructor(readonly capacity: number) {
    this.items = Array.from({ length: capacity }, blank);
  }

  spawn(
    ownerId: string,
    kit: HeroId,
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    speed: number,
    range: number,
    damage: number,
    hitRadius: number,
  ): SimProjectile | null {
    if (this.count >= this.capacity) return null;
    const p = this.items[this.count++]!;
    p.uid = this.nextUid++;
    p.ownerId = ownerId;
    p.kit = kit;
    p.hitRadius = hitRadius;
    p.x = x;
    p.z = z;
    p.dirX = dirX;
    p.dirZ = dirZ;
    p.speed = speed;
    p.range = range;
    p.damage = damage;
    p.travelled = 0;
    return p;
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
