/**
 * Turns irregular timer callbacks into fixed simulation steps (20 Hz by default).
 * After a long stall it runs at most `maxCatchUp` steps and drops the rest, so the
 * server never spirals trying to catch up.
 */
export class FixedTicker {
  private acc = 0;
  readonly stepMs: number;

  constructor(
    hz: number,
    private readonly maxCatchUp: number,
    private readonly onStep: () => void,
  ) {
    this.stepMs = 1000 / hz;
  }

  advance(deltaMs: number): void {
    if (!(deltaMs > 0)) return;
    this.acc += deltaMs;
    let steps = 0;
    while (this.acc >= this.stepMs - 1e-6 && steps < this.maxCatchUp) {
      this.onStep();
      this.acc -= this.stepMs;
      steps++;
    }
    if (this.acc >= this.stepMs - 1e-6) this.acc = 0;
    if (this.acc < 0) this.acc = 0;
  }
}
