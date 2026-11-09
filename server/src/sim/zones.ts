import type { Element } from '@crossfire/shared/heroes';

/** A Q zone on the ground. Combos (stage 1c) will fuse these. */
export interface SimZone {
  /** Stable id for the client. */
  uid: number;
  ownerId: string;
  element: Element;
  x: number;
  z: number;
  /** Seconds left. */
  remaining: number;
}

function blank(): SimZone {
  return { uid: 0, ownerId: '', element: 'fire', x: 0, z: 0, remaining: 0 };
}

/** Fixed-size pool of zones. Active ones are items[0..count); release swaps with the last. */
export class ZonePool {
  readonly items: SimZone[];
  count = 0;
  private nextUid = 1;

  constructor(readonly capacity: number) {
    this.items = Array.from({ length: capacity }, blank);
  }

  spawn(ownerId: string, element: Element, x: number, z: number, durationSec: number): SimZone | null {
    if (this.count >= this.capacity) return null;
    const zn = this.items[this.count++]!;
    zn.uid = this.nextUid++;
    zn.ownerId = ownerId;
    zn.element = element;
    zn.x = x;
    zn.z = z;
    zn.remaining = durationSec;
    return zn;
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
