import { constrainToArena, stepHero, type Pos } from '@crossfire/shared/rules/movement';
import { TUNING } from '@crossfire/shared/tuning';

export interface PredictorOptions {
  speed: number;
  /** Seconds per input (one server tick). */
  dt: number;
  cap: number;
  snapDistance: number;
  smoothingSec: number;
  ring: typeof TUNING.ring;
}

const DEFAULTS: PredictorOptions = {
  speed: TUNING.heroes.ember.speed,
  dt: 1 / TUNING.tickHz,
  cap: TUNING.client.pendingInputCap,
  snapDistance: TUNING.client.snapDistance,
  smoothingSec: TUNING.client.smoothingSec,
  ring: TUNING.ring,
};

/**
 * Predicts the player's own hero. Each input moves the hero one server tick with the same
 * rule the server uses; when a snapshot arrives, inputs the server has not applied yet are
 * replayed on top of its position. Any remaining difference is shown as an offset that eases
 * out, so corrections never jump (unless they are large).
 */
export class Predictor {
  x = 0;
  z = 0;
  facing = 0;
  /** Display offset left over from the last correction. */
  offsetX = 0;
  offsetZ = 0;
  private readonly o: PredictorOptions;
  // Ring buffer of pending inputs, preallocated.
  private readonly seqs: Int32Array;
  private readonly mx: Float64Array;
  private readonly mz: Float64Array;
  private head = 0;
  private count = 0;
  private readonly tmp: Pos = { x: 0, z: 0 };

  constructor(opts: Partial<PredictorOptions> = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.seqs = new Int32Array(this.o.cap);
    this.mx = new Float64Array(this.o.cap);
    this.mz = new Float64Array(this.o.cap);
  }

  get pendingCount(): number {
    return this.count;
  }

  /** Jumps to a position and forgets pending inputs (run start, downed, revived). */
  reset(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.offsetX = 0;
    this.offsetZ = 0;
    this.head = 0;
    this.count = 0;
  }

  /** Records an input that was just sent and applies it locally. */
  applyInput(seq: number, moveX: number, moveZ: number): void {
    if (this.count === this.o.cap) {
      this.head = (this.head + 1) % this.o.cap;
      this.count--;
    }
    const i = (this.head + this.count) % this.o.cap;
    this.seqs[i] = seq;
    this.mx[i] = moveX;
    this.mz[i] = moveZ;
    this.count++;
    stepHero(this, moveX, moveZ, this.o.speed, this.o.dt, this.o.ring);
  }

  setFacingFromAim(aimX: number, aimZ: number): void {
    const ax = aimX - this.x;
    const az = aimZ - this.z;
    if (ax * ax + az * az > 1e-6) this.facing = Math.atan2(ax, az);
  }

  /** Applies a server snapshot of this hero: position plus the last input it applied. */
  reconcile(serverX: number, serverZ: number, ackSeq: number): void {
    while (this.count > 0 && this.seqs[this.head]! <= ackSeq) {
      this.head = (this.head + 1) % this.o.cap;
      this.count--;
    }
    const p = this.tmp;
    p.x = serverX;
    p.z = serverZ;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head + k) % this.o.cap;
      stepHero(p, this.mx[i]!, this.mz[i]!, this.o.speed, this.o.dt, this.o.ring);
    }
    const ex = this.x + this.offsetX - p.x;
    const ez = this.z + this.offsetZ - p.z;
    if (Math.hypot(ex, ez) > this.o.snapDistance) {
      this.offsetX = 0;
      this.offsetZ = 0;
    } else {
      this.offsetX = ex;
      this.offsetZ = ez;
    }
    this.x = p.x;
    this.z = p.z;
  }

  /** Eases the display offset out. Call once per frame. */
  decay(frameDt: number): void {
    const k = Math.exp(-frameDt / this.o.smoothingSec);
    this.offsetX *= k;
    this.offsetZ *= k;
    if (Math.abs(this.offsetX) < 1e-5) this.offsetX = 0;
    if (Math.abs(this.offsetZ) < 1e-5) this.offsetZ = 0;
  }

  /**
   * Where to draw the hero: the predicted position moved `partialDt` further with the held
   * input (time since the last input was sent), plus the smoothing offset.
   */
  renderPos(out: Pos, partialDt: number, moveX: number, moveZ: number): void {
    out.x = this.x;
    out.z = this.z;
    const len = Math.hypot(moveX, moveZ);
    if (len > 1e-6 && partialDt > 0) {
      const k = (this.o.speed * Math.min(partialDt, this.o.dt)) / Math.max(1, len);
      out.x += moveX * k;
      out.z += moveZ * k;
      constrainToArena(out, this.o.ring);
    }
    out.x += this.offsetX;
    out.z += this.offsetZ;
  }
}
