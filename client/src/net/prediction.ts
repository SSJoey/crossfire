import { heroKit, type HeroId } from '@crossfire/shared/heroes';
import { blinkTarget, dashStep } from '@crossfire/shared/rules/abilities';
import { constrainToArena, stepHero, type Pos } from '@crossfire/shared/rules/movement';
import { TUNING } from '@crossfire/shared/tuning';
import type { CastId } from '@crossfire/shared/types';

export interface PredictorOptions {
  /** Seconds per input (one server tick). */
  dt: number;
  cap: number;
  snapDistance: number;
  smoothingSec: number;
  ring: typeof TUNING.ring;
}

const DEFAULTS: PredictorOptions = {
  dt: 1 / TUNING.tickHz,
  cap: TUNING.client.pendingInputCap,
  snapDistance: TUNING.client.snapDistance,
  smoothingSec: TUNING.client.smoothingSec,
  ring: TUNING.ring,
};

/** What one input did to the hero's position (decided when it was applied). */
const MODE_MOVE = 0;
const MODE_BLINK = 1;
const MODE_DASH = 2;

/**
 * Predicts the player's own hero. Each input moves the hero one server tick with the same
 * rules the server uses (walking, Flame step, Gust dash); when a snapshot arrives, inputs the
 * server has not applied yet are replayed on top of its position. Any remaining difference is
 * shown as an offset that eases out, so corrections never jump (unless they are large).
 */
export class Predictor {
  x = 0;
  z = 0;
  facing = 0;
  /** Display offset left over from the last correction. */
  offsetX = 0;
  offsetZ = 0;
  private readonly o: PredictorOptions;
  private hero: HeroId = 'ember';
  private speed: number = heroKit('ember').speed;
  // Ring buffer of pending inputs, preallocated.
  private readonly seqs: Int32Array;
  private readonly mx: Float64Array;
  private readonly mz: Float64Array;
  private readonly ax: Float64Array;
  private readonly az: Float64Array;
  private readonly mode: Uint8Array;
  /** E cast at this input (it started the cooldown). */
  private readonly castE: Uint8Array;
  /** Dash direction of a dash-tick input. */
  private readonly dx: Float64Array;
  private readonly dz: Float64Array;
  private head = 0;
  private count = 0;
  /** Predicted E cooldown left and dash state after the last applied input. */
  private eCd = 0;
  private dashLeft = 0;
  private dashDirX = 0;
  private dashDirZ = 1;
  private readonly tmp: Pos = { x: 0, z: 0 };

  constructor(opts: Partial<PredictorOptions> = {}) {
    this.o = { ...DEFAULTS, ...opts };
    const n = this.o.cap;
    this.seqs = new Int32Array(n);
    this.mx = new Float64Array(n);
    this.mz = new Float64Array(n);
    this.ax = new Float64Array(n);
    this.az = new Float64Array(n);
    this.mode = new Uint8Array(n);
    this.castE = new Uint8Array(n);
    this.dx = new Float64Array(n);
    this.dz = new Float64Array(n);
  }

  get pendingCount(): number {
    return this.count;
  }

  /** True while a predicted Gust dash has ticks left. */
  get dashing(): boolean {
    return this.dashLeft > 1e-9;
  }

  /** The hero being predicted (run start, debug switch): sets its speed and E. */
  setHero(id: HeroId): void {
    this.hero = id;
    this.speed = heroKit(id).speed;
  }

  /** Jumps to a position and forgets pending inputs and any dash (run start, downed, revived). */
  reset(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.offsetX = 0;
    this.offsetZ = 0;
    this.head = 0;
    this.count = 0;
    this.dashLeft = 0;
  }

  /**
   * True if an E sent in the next input would fire: the server ticks the cooldown down
   * before it looks at the cast, so this looks one tick ahead.
   */
  eReady(): boolean {
    return Math.max(0, this.eCd - this.o.dt) <= 1e-9;
  }

  /**
   * Records an input that was just sent and applies it locally. `aimX/aimZ` matter only for
   * a cast; a Q cast never moves the hero.
   */
  applyInput(seq: number, moveX: number, moveZ: number, cast: CastId = 'none', aimX = 0, aimZ = 0): void {
    if (this.count === this.o.cap) {
      this.head = (this.head + 1) % this.o.cap;
      this.count--;
    }
    const i = (this.head + this.count) % this.o.cap;
    this.seqs[i] = seq;
    this.mx[i] = moveX;
    this.mz[i] = moveZ;
    this.ax[i] = aimX;
    this.az[i] = aimZ;
    this.castE[i] = 0;
    this.count++;

    // Same order as the server's tick: cooldown, cast, then dash or walk.
    this.eCd = Math.max(0, this.eCd - this.o.dt);
    if (cast === 'e' && this.eCd <= 1e-9) {
      this.castE[i] = 1;
      this.eCd = heroKit(this.hero).utility.cooldownSec;
      if (this.hero === 'gale') {
        this.aimDir(this.x, this.z, aimX, aimZ, this.tmp);
        this.dashDirX = this.tmp.x;
        this.dashDirZ = this.tmp.z;
        this.dashLeft = heroKit('gale').utility.durationSec;
      }
    }
    if (this.castE[i] && this.hero === 'ember') this.mode[i] = MODE_BLINK;
    else if (this.dashLeft > 1e-9) {
      this.mode[i] = MODE_DASH;
      this.dx[i] = this.dashDirX;
      this.dz[i] = this.dashDirZ;
      this.dashLeft = Math.max(0, this.dashLeft - this.o.dt);
      if (this.dashLeft <= 1e-9) this.dashLeft = 0;
    } else this.mode[i] = MODE_MOVE;
    this.stepOne(this, i);
  }

  setFacingFromAim(aimX: number, aimZ: number): void {
    const ax = aimX - this.x;
    const az = aimZ - this.z;
    if (ax * ax + az * az > 1e-6) this.facing = Math.atan2(ax, az);
  }

  /**
   * Applies a server snapshot of this hero: its position, the last input it applied and,
   * when known, its E cooldown left (for `eReady`).
   */
  reconcile(serverX: number, serverZ: number, ackSeq: number, serverECd?: number): void {
    while (this.count > 0 && this.seqs[this.head]! <= ackSeq) {
      this.head = (this.head + 1) % this.o.cap;
      this.count--;
    }
    const p = this.tmp;
    p.x = serverX;
    p.z = serverZ;
    let cd = serverECd ?? this.eCd;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head + k) % this.o.cap;
      this.stepOne(p, i);
      cd = this.castE[i] ? heroKit(this.hero).utility.cooldownSec : Math.max(0, cd - this.o.dt);
    }
    if (serverECd !== undefined) this.eCd = cd;
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
   * Where to draw the hero: the predicted position moved `partialDt` further (time since the
   * last input was sent), along the dash while one lasts, else with the held input; plus the
   * smoothing offset.
   */
  renderPos(out: Pos, partialDt: number, moveX: number, moveZ: number): void {
    out.x = this.x;
    out.z = this.z;
    const t = Math.min(partialDt, this.o.dt);
    if (t > 0 && this.dashLeft > 1e-9) {
      const u = heroKit('gale').utility;
      dashStep(out, this.dashDirX, this.dashDirZ, u.distance / u.durationSec, t, this.o.ring);
    } else {
      const len = Math.hypot(moveX, moveZ);
      if (len > 1e-6 && t > 0) {
        const k = (this.speed * t) / Math.max(1, len);
        out.x += moveX * k;
        out.z += moveZ * k;
        constrainToArena(out, this.o.ring);
      }
    }
    out.x += this.offsetX;
    out.z += this.offsetZ;
  }

  /** Moves `p` by pending input `i`, as the server would. */
  private stepOne(p: Pos, i: number): void {
    const m = this.mode[i];
    if (m === MODE_BLINK) {
      blinkTarget(p.x, p.z, this.ax[i]!, this.az[i]!, heroKit('ember').utility.range, p, this.o.ring);
      stepHero(p, this.mx[i]!, this.mz[i]!, this.speed, this.o.dt, this.o.ring);
    } else if (m === MODE_DASH) {
      const u = heroKit('gale').utility;
      dashStep(p, this.dx[i]!, this.dz[i]!, u.distance / u.durationSec, this.o.dt, this.o.ring);
    } else {
      stepHero(p, this.mx[i]!, this.mz[i]!, this.speed, this.o.dt, this.o.ring);
    }
  }

  /** Unit aim direction from (x, z), or the facing when aiming at the hero (server rule). */
  private aimDir(x: number, z: number, aimX: number, aimZ: number, out: Pos): void {
    const dx = aimX - x;
    const dz = aimZ - z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      out.x = dx / len;
      out.z = dz / len;
    } else {
      out.x = Math.sin(this.facing);
      out.z = Math.cos(this.facing);
    }
  }
}
