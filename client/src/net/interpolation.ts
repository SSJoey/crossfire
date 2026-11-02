export interface Sample {
  x: number;
  z: number;
  facing: number;
}

/** Interpolates an angle the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

/**
 * The last few snapshots of one remote entity, in fixed preallocated storage.
 * Entities are drawn a little in the past so there are always two snapshots to blend.
 * Past the newest snapshot the value is held, never extrapolated.
 */
export class SnapshotBuffer {
  private readonly t: Float64Array;
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  private readonly f: Float32Array;
  private head = 0;
  private n = 0;

  constructor(private readonly cap: number) {
    this.t = new Float64Array(cap);
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.f = new Float32Array(cap);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.head = 0;
    this.n = 0;
  }

  push(time: number, x: number, z: number, facing: number): void {
    let i: number;
    if (this.n < this.cap) {
      i = (this.head + this.n) % this.cap;
      this.n++;
    } else {
      i = this.head;
      this.head = (this.head + 1) % this.cap;
    }
    this.t[i] = time;
    this.x[i] = x;
    this.z[i] = z;
    this.f[i] = facing;
  }

  private idx(k: number): number {
    return (this.head + k) % this.cap;
  }

  /** Writes the value at `time` into `out`. Returns false when there are no snapshots. */
  sample(time: number, out: Sample): boolean {
    if (this.n === 0) return false;
    const first = this.idx(0);
    if (this.n === 1 || time <= this.t[first]!) return this.copy(first, out);
    const last = this.idx(this.n - 1);
    if (time >= this.t[last]!) return this.copy(last, out);
    for (let k = this.n - 1; k > 0; k--) {
      const b = this.idx(k);
      const a = this.idx(k - 1);
      if (time >= this.t[a]!) {
        const span = this.t[b]! - this.t[a]!;
        const u = span > 0 ? (time - this.t[a]!) / span : 1;
        out.x = this.x[a]! + (this.x[b]! - this.x[a]!) * u;
        out.z = this.z[a]! + (this.z[b]! - this.z[a]!) * u;
        out.facing = lerpAngle(this.f[a]!, this.f[b]!, u);
        return true;
      }
    }
    return this.copy(first, out);
  }

  private copy(i: number, out: Sample): boolean {
    out.x = this.x[i]!;
    out.z = this.z[i]!;
    out.facing = this.f[i]!;
    return true;
  }
}
