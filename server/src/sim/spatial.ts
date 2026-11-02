/**
 * Uniform grid over the XZ plane for "who is near this point" queries.
 * Rebuilt every tick from scratch; uses typed arrays only, so it allocates nothing per tick.
 */
export class SpatialGrid {
  private readonly cols: number;
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  readonly result: Int32Array;

  constructor(
    private readonly halfExtent: number,
    private readonly cellSize: number,
    capacity: number,
  ) {
    this.cols = Math.ceil((halfExtent * 2) / cellSize);
    this.head = new Int32Array(this.cols * this.cols).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
    this.result = new Int32Array(capacity);
  }

  clear(): void {
    this.head.fill(-1);
  }

  private cell(v: number): number {
    const c = Math.floor((v + this.halfExtent) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  insert(i: number, x: number, z: number): void {
    const k = this.cell(z) * this.cols + this.cell(x);
    this.next[i] = this.head[k]!;
    this.head[k] = i;
  }

  /** Writes candidate indices near (x, z) within r into `result`; returns how many. */
  query(x: number, z: number, r: number): number {
    const c0 = this.cell(x - r);
    const c1 = this.cell(x + r);
    const r0 = this.cell(z - r);
    const r1 = this.cell(z + r);
    let n = 0;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        for (let i = this.head[row * this.cols + col]!; i !== -1; i = this.next[i]!) {
          if (n < this.result.length) this.result[n++] = i;
        }
      }
    }
    return n;
  }
}
