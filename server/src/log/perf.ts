/**
 * Tick-time statistics in a fixed histogram: adding a sample allocates nothing.
 * Percentiles are accurate to one bucket; samples beyond the histogram report the true maximum.
 */
export class TickStats {
  private readonly buckets: Uint32Array;
  count = 0;
  max = 0;

  constructor(
    private readonly bucketMs = 0.05,
    maxMs = 50,
  ) {
    this.buckets = new Uint32Array(Math.ceil(maxMs / bucketMs) + 1);
  }

  add(ms: number): void {
    if (!(ms >= 0)) return;
    const i = Math.min(this.buckets.length - 1, Math.floor(ms / this.bucketMs));
    this.buckets[i]!++;
    this.count++;
    if (ms > this.max) this.max = ms;
  }

  /** Upper edge of the bucket holding the p-th sample (0 < p ≤ 1), capped at the maximum. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.max(1, Math.ceil(p * this.count));
    let seen = 0;
    const last = this.buckets.length - 1;
    for (let i = 0; i < last; i++) {
      seen += this.buckets[i]!;
      if (seen >= rank) return Math.min(this.max, (i + 1) * this.bucketMs);
    }
    return this.max;
  }

  reset(): void {
    this.buckets.fill(0);
    this.count = 0;
    this.max = 0;
  }
}

/** Kilobytes (1000 bytes) per second between two readings of a byte counter. */
export function kBps(bytesNow: number, bytesBefore: number, elapsedMs: number): number {
  if (!(elapsedMs > 0) || !(bytesNow >= bytesBefore)) return 0;
  return (bytesNow - bytesBefore) / elapsedMs;
}

export function memoryMB(): { heapMB: number; rssMB: number } {
  const m = process.memoryUsage();
  return { heapMB: m.heapUsed / 1e6, rssMB: m.rss / 1e6 };
}

/**
 * Bytes written so far to a client's socket, WebSocket framing included. Reads the `ws` socket
 * under the Colyseus client (`client.ref._socket`, ws 8.x); returns 0 if that shape is absent.
 */
export function socketBytesWritten(ref: unknown): number {
  const sock = (ref as { _socket?: { bytesWritten?: unknown } } | null)?._socket;
  const n = sock?.bytesWritten;
  return typeof n === 'number' ? n : 0;
}
