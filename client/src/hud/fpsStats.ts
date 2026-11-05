/** Frame-time statistics over a fixed ring buffer (no allocation per frame). */
export class FpsStats {
  private readonly frames: Float32Array;
  private readonly scratch: Float32Array;
  private head = 0;
  private size = 0;

  constructor(capacity = 600) {
    this.frames = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  /** Adds one frame's duration in milliseconds. */
  add(frameMs: number): void {
    if (!(frameMs > 0)) return;
    this.frames[this.head] = frameMs;
    this.head = (this.head + 1) % this.frames.length;
    if (this.size < this.frames.length) this.size++;
  }

  /** Average fps over the most recent second of frames. */
  fps(windowMs = 1000): number {
    let sum = 0;
    let n = 0;
    const cap = this.frames.length;
    while (n < this.size && sum < windowMs - 1e-3) {
      sum += this.frames[(this.head - 1 - n + cap) % cap]!;
      n++;
    }
    return sum > 0 ? (n * 1000) / sum : 0;
  }

  /** "1% low": fps over the slowest 1% of the newest `lastN` stored frames (default all, at least one). */
  low1(lastN = this.size): number {
    const n = Math.min(this.size, Math.max(0, Math.floor(lastN)));
    if (n === 0) return 0;
    const cap = this.frames.length;
    const s = this.scratch.subarray(0, n);
    for (let i = 0; i < n; i++) s[i] = this.frames[(this.head - 1 - i + cap) % cap]!;
    s.sort();
    const k = Math.max(1, Math.ceil(n * 0.01));
    let sum = 0;
    for (let i = n - k; i < n; i++) sum += s[i]!;
    return (k * 1000) / sum;
  }
}
