import { HEROES, heroKit, type HeroId } from '@crossfire/shared/heroes';
import {
  assistRange,
  blinkTarget,
  canCast,
  clampCast,
  damageTaken,
  dashStep,
  healed,
  meleeHits,
  strongestSlow,
  tailwindHit,
} from '@crossfire/shared/rules/abilities';
import { assistTarget } from '@crossfire/shared/rules/aim';
import { applyDamage } from '@crossfire/shared/rules/health';
import { stepHero, type Pos } from '@crossfire/shared/rules/movement';
import { downIfDepleted, stepRevive } from '@crossfire/shared/rules/revive';
import { ringHealth } from '@crossfire/shared/rules/ring';
import { acceptSeq, isStale } from '@crossfire/shared/rules/validation';
import { TUNING, type Tuning } from '@crossfire/shared/tuning';
import type { InputMessage, WaveState } from '@crossfire/shared/types';
import { EnemyPool, type SimEnemy } from './enemies';
import { applyKit, clearKitEffects, createHero, resetHero, type HeroAct, type SimHero } from './heroes';
import { ProjectilePool } from './projectiles';
import { Rng } from './rng';
import { SpatialGrid } from './spatial';
import { WaveDirector } from './waves';
import { ZonePool } from './zones';

export type WorldEvent =
  | { type: 'waveStarted'; wave: number }
  | { type: 'waveCleared'; wave: number }
  | { type: 'heroDowned'; id: string }
  | { type: 'heroDied'; id: string }
  | { type: 'heroRevived'; id: string }
  | { type: 'runEnded'; wave: number; durationSec: number };

export type WorldPhase = 'idle' | 'running' | 'ended';

export interface WorldOptions {
  seed?: number;
  tuning?: Tuning;
}

const PROJECTILE_CAP = 256;

/**
 * The authoritative game simulation, in plain data (no networking).
 * The room feeds it inputs and calls step() at a fixed rate; it mirrors the result into state.
 */
export class World {
  readonly t: Tuning;
  readonly dt: number;
  readonly heroes = new Map<string, SimHero>();
  /** Same heroes as an array, for the revive rules (rebuilt on add/remove only). */
  private heroList: SimHero[] = [];
  readonly enemies: EnemyPool;
  readonly projectiles: ProjectilePool;
  readonly zones: ZonePool;
  private readonly grid: SpatialGrid;
  private readonly waves: WaveDirector;
  private readonly rng: Rng;
  phase: WorldPhase = 'idle';
  /** Events produced by the last step(). */
  readonly events: WorldEvent[] = [];
  private startMs = 0;
  private nowMs = 0;
  kills = 0;
  /** Scratch space for the hot loops (nothing is allocated per tick). */
  private readonly tmp: Pos = { x: 0, z: 0 };
  private readonly hitBuf: Int32Array;
  private readonly tw = { count: 0, mult: 1 };
  /** Per-tick knockback decay factor. */
  private readonly kvDecay: number;
  /** Bolt-vs-enemy search radius for the grid (largest bolt hit radius + largest enemy). */
  private readonly boltReach: number;
  private dashCounter = 0;

  constructor(opts: WorldOptions = {}) {
    this.t = opts.tuning ?? TUNING;
    this.dt = 1 / this.t.tickHz;
    this.rng = new Rng(opts.seed ?? 1);
    this.enemies = new EnemyPool(this.t.waves.enemyCap);
    this.projectiles = new ProjectilePool(PROJECTILE_CAP);
    this.zones = new ZonePool(this.t.zones.cap);
    this.hitBuf = new Int32Array(this.t.waves.enemyCap);
    this.kvDecay = Math.exp(-this.t.knockbackDecayPerSec * this.dt);
    const h = this.t.heroes;
    this.boltReach =
      Math.max(h.ember.bolt.hitRadius, h.tide.bolt.hitRadius) +
      this.t.minion.radius * this.t.minion.levelScaleCap;
    this.grid = new SpatialGrid(this.t.ring.mapRadius + 4, 2, this.t.waves.enemyCap);
    this.waves = new WaveDirector(this.t);
  }

  get wave(): number {
    return this.waves.wave;
  }

  get waveState(): WaveState {
    return this.waves.state;
  }

  get spawnedThisWave(): number {
    return this.waves.spawned;
  }

  get waveTotal(): number {
    return this.waves.total;
  }

  addHero(id: string, name: string, heroId: HeroId = 'ember'): SimHero {
    const used = new Set([...this.heroes.values()].map((h) => h.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const h = createHero(id, name, slot, heroId, this.t);
    this.heroes.set(id, h);
    this.heroList = [...this.heroes.values()];
    return h;
  }

  removeHero(id: string): void {
    this.heroes.delete(id);
    this.heroList = [...this.heroes.values()];
  }

  /**
   * Debug hero switch during a run. Keeps the HP fraction and the remaining Q/E cooldowns (so it
   * never bypasses one); ends kit-only effects. Refused unless standing, at most once per
   * `heroSwitchSec`, and never to the same hero.
   */
  switchHero(id: string, heroId: HeroId): boolean {
    const h = this.heroes.get(id);
    if (!h || this.phase !== 'running' || h.status !== 'standing') return false;
    if (h.switchCd > 1e-9 || h.heroId === heroId) return false;
    const frac = h.maxHp > 0 ? h.hp / h.maxHp : 1;
    applyKit(h, heroId, this.t);
    h.hp = frac * h.maxHp;
    clearKitEffects(h);
    h.switchCd = this.t.heroSwitchSec;
    return true;
  }

  /** Starts a fresh run with the current heroes. */
  start(nowMs: number): void {
    this.enemies.clear();
    this.projectiles.clear();
    this.zones.clear();
    this.kills = 0;
    this.startMs = nowMs;
    this.nowMs = nowMs;
    const slots = Math.max(this.t.lobby.maxPlayers, this.heroes.size);
    for (const h of this.heroList) resetHero(h, slots, nowMs, this.t);
    this.waves.start(this.heroes.size);
    this.phase = 'running';
    this.events.length = 0;
  }

  stop(): void {
    this.phase = 'idle';
    this.enemies.clear();
    this.projectiles.clear();
    this.zones.clear();
  }

  /** Applies a validated input. Returns false if it is out of order or the hero is unknown. */
  setInput(id: string, input: InputMessage, nowMs: number): boolean {
    const h = this.heroes.get(id);
    if (!h || !acceptSeq(h.input.seq, input.seq)) return false;
    const cur = h.input;
    cur.seq = input.seq;
    cur.moveX = input.moveX;
    cur.moveZ = input.moveZ;
    cur.aimX = input.aimX;
    cur.aimZ = input.aimZ;
    cur.attack = input.attack;
    cur.revive = input.revive;
    cur.qHeld = input.qHeld;
    cur.cast = input.cast;
    // A cast is latched until the next tick, so one arriving between ticks is not lost.
    if (input.cast !== 'none' && h.pendingCast === 'none') h.pendingCast = input.cast;
    h.lastInputMs = nowMs;
    return true;
  }

  /** One fixed simulation step. */
  step(nowMs: number): void {
    this.events.length = 0;
    if (this.phase !== 'running') return;
    this.nowMs = nowMs;
    const dt = this.dt;

    this.downDepletedHeroes();
    this.stepHeroes(dt);
    this.rebuildGrid();
    this.stepZones(dt);
    this.stepEnemies(dt);
    this.stepBurns(dt);
    this.stepProjectiles(dt);
    this.removeDeadEnemies();
    this.downDepletedHeroes();
    stepRevive(this.heroList, dt, this.t.revive);
    this.emitStatusChanges();
    this.stepWaves(dt);
    this.checkRunEnd();
  }

  private downDepletedHeroes(): void {
    for (const h of this.heroList) downIfDepleted(h, this.t.revive);
  }

  /** Damages an enemy; a kill makes it untargetable and counts. */
  private damageEnemy(e: SimEnemy, amount: number): void {
    if (e.hp <= 0) return;
    e.hp = applyDamage(e.hp, amount);
    if (e.hp <= 0) {
      e.targetable = false;
      this.kills++;
    }
  }

  private setAct(h: SimHero, act: HeroAct): void {
    h.act = act;
    h.actSeq = (h.actSeq + 1) & 0xff;
  }

  private stepHeroes(dt: number): void {
    for (const h of this.heroList) {
      const inp = h.input;
      if (isStale(h.lastInputMs, this.nowMs, this.t.net.staleInputMs)) {
        inp.moveX = 0;
        inp.moveZ = 0;
        inp.attack = false;
        inp.revive = false;
        inp.qHeld = false;
        h.pendingCast = 'none';
      }
      h.attackCd = Math.max(0, h.attackCd - dt);
      h.qCd = Math.max(0, h.qCd - dt);
      h.eCd = Math.max(0, h.eCd - dt);
      h.switchCd = Math.max(0, h.switchCd - dt);
      if (h.status !== 'standing') {
        // A refused cast is dropped, never saved for after a revive.
        h.pendingCast = 'none';
        h.holdingRevive = false;
        h.dashT = 0;
        h.stoneSkinT = Math.max(0, h.stoneSkinT - dt);
        continue;
      }
      const ax = inp.aimX - h.x;
      const az = inp.aimZ - h.z;
      if (ax * ax + az * az > 1e-6) h.facing = Math.atan2(ax, az);
      h.holdingRevive = inp.revive;

      const cast = h.pendingCast;
      h.pendingCast = 'none';
      if (cast === 'q' && canCast(h.status, h.qCd)) this.castZone(h);
      else if (cast === 'e' && canCast(h.status, h.eCd)) this.castUtility(h);

      if (h.dashT > 1e-9) this.stepDash(h, dt);
      else stepHero(h, inp.moveX, inp.moveZ, h.speed, dt, this.t.ring);

      if (inp.attack && h.attackCd <= 1e-9) this.basicAttack(h);

      h.hp = ringHealth(h.hp, h.maxHp, h.x, h.z, dt, h.status, this.t.ring);
      h.stoneSkinT = Math.max(0, h.stoneSkinT - dt);
    }
  }

  /** The hero's aim direction as a unit vector (its facing if aiming at itself). */
  private aimDir(h: SimHero, out: Pos): void {
    const dx = h.input.aimX - h.x;
    const dz = h.input.aimZ - h.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      out.x = dx / len;
      out.z = dz / len;
    } else {
      out.x = Math.sin(h.facing);
      out.z = Math.cos(h.facing);
    }
  }

  private castZone(h: SimHero): void {
    const zt = this.t.zones;
    const p = this.tmp;
    clampCast(h.x, h.z, h.input.aimX, h.input.aimZ, zt.castRange, p);
    const element = HEROES[h.heroId].element;
    const zn = this.zones.spawn(h.id, element, p.x, p.z, zt.durationSec);
    if (!zn) return; // pool full: refused, no cooldown
    if (element === 'earth') {
      const r2 = zt.radius * zt.radius;
      const items = this.enemies.items;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i]!;
        if (!e.targetable || e.hp <= 0) continue;
        if ((e.x - zn.x) ** 2 + (e.z - zn.z) ** 2 > r2) continue;
        this.damageEnemy(e, zt.earth.impactDamage);
        e.stunT = Math.max(e.stunT, zt.earth.stunSec);
      }
    }
    h.qCd = zt.cooldownSec;
    this.setAct(h, 'q');
  }

  private castUtility(h: SimHero): void {
    const items = this.enemies.items;
    switch (h.heroId) {
      case 'ember': {
        const u = heroKit('ember', 1, this.t).utility;
        blinkTarget(h.x, h.z, h.input.aimX, h.input.aimZ, u.range, this.tmp, this.t.ring);
        h.x = this.tmp.x;
        h.z = this.tmp.z;
        h.eCd = u.cooldownSec;
        break;
      }
      case 'bastion': {
        const u = heroKit('bastion', 1, this.t).utility;
        h.stoneSkinT = u.durationSec;
        const r2 = u.tauntRadius * u.tauntRadius;
        for (let i = 0; i < this.enemies.count; i++) {
          const e = items[i]!;
          if (!e.targetable || e.hp <= 0) continue;
          if ((e.x - h.x) ** 2 + (e.z - h.z) ** 2 > r2) continue;
          e.tauntId = h.id;
          e.tauntT = u.tauntSec;
        }
        h.eCd = u.cooldownSec;
        break;
      }
      case 'tide': {
        const u = heroKit('tide', 1, this.t).utility;
        const r2 = u.radius * u.radius;
        for (const o of this.heroList) {
          if (o.status !== 'standing') continue;
          if ((o.x - h.x) ** 2 + (o.z - h.z) ** 2 > r2) continue;
          o.hp = healed(o.hp, o.maxHp, u.healFrac);
        }
        h.eCd = u.cooldownSec;
        break;
      }
      case 'gale': {
        const u = heroKit('gale', 1, this.t).utility;
        this.aimDir(h, this.tmp);
        h.dashDirX = this.tmp.x;
        h.dashDirZ = this.tmp.z;
        h.dashT = u.durationSec;
        h.dashId = ++this.dashCounter;
        h.eCd = u.cooldownSec;
        break;
      }
    }
    this.setAct(h, 'e');
  }

  /** One tick of Gust dash: move, and knock aside every enemy the swept path touches (once per dash). */
  private stepDash(h: SimHero, dt: number): void {
    const u = heroKit('gale', 1, this.t).utility;
    const px = h.x;
    const pz = h.z;
    dashStep(h, h.dashDirX, h.dashDirZ, u.distance / u.durationSec, dt, this.t.ring);
    h.dashT = Math.max(0, h.dashT - dt);
    if (h.dashT <= 1e-9) h.dashT = 0;
    const dx = h.dashDirX;
    const dz = h.dashDirZ;
    const stepLen = Math.hypot(h.x - px, h.z - pz);
    // Initial knockback speed that slides exactly `knockback` metres with the per-tick decay.
    const v0 = (u.knockback * (1 - this.kvDecay)) / this.dt;
    const items = this.enemies.items;
    for (let i = 0; i < this.enemies.count; i++) {
      const e = items[i]!;
      if (!e.targetable || e.hp <= 0 || e.dashHitId === h.dashId) continue;
      const rx = e.x - px;
      const rz = e.z - pz;
      const along = rx * dx + rz * dz;
      const side = rx * dz - rz * dx;
      if (along < -e.radius || along > stepLen + e.radius) continue;
      if (Math.abs(side) > u.pathWidth + e.radius) continue;
      const s = side >= 0 ? 1 : -1;
      e.kvx += s * dz * v0;
      e.kvz += -s * dx * v0;
      e.dashHitId = h.dashId;
    }
  }

  private basicAttack(h: SimHero): void {
    const kit = heroKit(h.heroId, 1, this.t);
    const inp = h.input;
    if ('bolt' in kit) {
      const bolt = kit.bolt;
      let tx = inp.aimX;
      let tz = inp.aimZ;
      if (this.t.aim.assistOn) {
        const i = assistTarget(
          h.x,
          h.z,
          inp.aimX,
          inp.aimZ,
          assistRange(h.heroId, this.t),
          this.t.aim.assistCone,
          this.enemies.items,
          this.enemies.count,
        );
        if (i >= 0) {
          const e = this.enemies.items[i]!;
          tx = e.x;
          tz = e.z;
        }
      }
      const dx = tx - h.x;
      const dz = tz - h.z;
      const len = Math.hypot(dx, dz);
      const dirX = len > 1e-6 ? dx / len : Math.sin(h.facing);
      const dirZ = len > 1e-6 ? dz / len : Math.cos(h.facing);
      h.facing = Math.atan2(dirX, dirZ);
      this.projectiles.spawn(
        h.id,
        h.heroId,
        h.x,
        h.z,
        dirX,
        dirZ,
        bolt.speed,
        bolt.range,
        bolt.damage,
        bolt.hitRadius,
      );
      h.attackCd = bolt.intervalSec;
    } else {
      const melee = kit.melee;
      const m = this.t.melee;
      if (this.t.aim.assistOn) {
        const i = assistTarget(
          h.x,
          h.z,
          inp.aimX,
          inp.aimZ,
          assistRange(h.heroId, this.t),
          this.t.aim.assistCone,
          this.enemies.items,
          this.enemies.count,
        );
        if (i >= 0) {
          const e = this.enemies.items[i]!;
          const dx = e.x - h.x;
          const dz = e.z - h.z;
          if (dx * dx + dz * dz > 1e-6) h.facing = Math.atan2(dx, dz);
        }
      }
      const fx = Math.sin(h.facing);
      const fz = Math.cos(h.facing);
      const items = this.enemies.items;
      const n = meleeHits(h.x, h.z, fx, fz, melee.reach, items, this.enemies.count, this.hitBuf, m);
      let mult = 1;
      if (n > 0 && h.heroId === 'gale') {
        const p = heroKit('gale', 1, this.t).passive;
        tailwindHit(h.tailwindCount, p.every, p.mult, this.tw);
        h.tailwindCount = this.tw.count;
        mult = this.tw.mult;
      }
      for (let k = 0; k < n; k++) {
        const e = items[this.hitBuf[k]!]!;
        this.damageEnemy(e, melee.damage * mult);
        const dx = e.x - h.x;
        const dz = e.z - h.z;
        const d = Math.hypot(dx, dz);
        const kx = d > 1e-6 ? dx / d : fx;
        const kz = d > 1e-6 ? dz / d : fz;
        e.kvx += kx * m.knockbackSpeed;
        e.kvz += kz * m.knockbackSpeed;
      }
      h.attackCd = melee.intervalSec;
    }
    this.setAct(h, 'attack');
  }

  private rebuildGrid(): void {
    this.grid.clear();
    const items = this.enemies.items;
    for (let i = 0; i < this.enemies.count; i++) this.grid.insert(i, items[i]!.x, items[i]!.z);
  }

  /** Q zones: damage, slow, pull; then they age out. */
  private stepZones(dt: number): void {
    const zt = this.t.zones;
    const r2 = zt.radius * zt.radius;
    const items = this.enemies.items;
    for (let zi = this.zones.count - 1; zi >= 0; zi--) {
      const zn = this.zones.items[zi]!;
      const el = zn.element;
      const dps =
        el === 'fire'
          ? zt.fire.dps
          : el === 'earth'
            ? zt.earth.dps
            : el === 'water'
              ? zt.water.dps
              : zt.air.dps;
      for (let i = 0; i < this.enemies.count; i++) {
        const e = items[i]!;
        if (!e.targetable || e.hp <= 0) continue;
        const dx = zn.x - e.x;
        const dz = zn.z - e.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        this.damageEnemy(e, dps * dt);
        if (el === 'water') {
          e.zoneSlowFrac = e.zoneSlowT > 0 ? Math.max(e.zoneSlowFrac, zt.water.slowFrac) : zt.water.slowFrac;
          e.zoneSlowT = zt.water.slowHoldSec;
        } else if (el === 'air') {
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            const step = Math.min(d, zt.air.pullSpeed * dt);
            e.x += (dx / d) * step;
            e.z += (dz / d) * step;
          }
        }
      }
      zn.remaining -= dt;
      if (zn.remaining <= 1e-9) this.zones.release(zi);
    }
  }

  private nearestStanding(x: number, z: number): SimHero | null {
    let best: SimHero | null = null;
    let bd = Infinity;
    for (const h of this.heroList) {
      if (h.status !== 'standing') continue;
      const d = (h.x - x) ** 2 + (h.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  /** A taunted enemy follows its taunter while that hero stands; otherwise the nearest hero. */
  private targetFor(e: SimEnemy): SimHero | null {
    if (e.tauntT > 0 && e.tauntId !== null) {
      const h = this.heroes.get(e.tauntId);
      if (h && h.status === 'standing') return h;
      e.tauntId = null;
      e.tauntT = 0;
    }
    return this.nearestStanding(e.x, e.z);
  }

  private stepEnemies(dt: number): void {
    const m = this.t.minion;
    const items = this.enemies.items;
    const hold = this.t.ring.holdRadius;
    const decay = this.kvDecay;
    for (let i = 0; i < this.enemies.count; i++) {
      const e = items[i]!;
      if (e.hp <= 0) continue;
      e.swingCd = Math.max(0, e.swingCd - dt);
      if (e.state === 'spawning') {
        e.timer -= dt;
        if (e.timer > 1e-9) continue;
        e.state = 'moving';
        e.targetable = true;
      }
      e.stunT = Math.max(0, e.stunT - dt);
      e.zoneSlowT = Math.max(0, e.zoneSlowT - dt);
      e.boltSlowT = Math.max(0, e.boltSlowT - dt);
      e.tauntT = Math.max(0, e.tauntT - dt);
      if (e.tauntT <= 0) e.tauntId = null;
      const stunned = e.stunT > 1e-9;

      const target = this.targetFor(e);
      e.targetId = target ? target.id : null;
      let vx = 0;
      let vz = 0;
      let dist = Infinity;
      let dirX = 0;
      let dirZ = 0;
      if (target) {
        const dx = target.x - e.x;
        const dz = target.z - e.z;
        dist = Math.hypot(dx, dz);
        if (dist > 1e-6) {
          dirX = dx / dist;
          dirZ = dz / dist;
          if (!stunned) e.facing = Math.atan2(dirX, dirZ);
        }
      }

      if (stunned) {
        // A stun cancels a swing in progress.
        if (e.state === 'winding') e.state = 'moving';
      } else if (e.state === 'winding') {
        e.timer -= dt;
        if (e.timer <= 1e-9) {
          if (target && target.status === 'standing' && dist <= m.hitReach * e.scale) {
            const dmg = damageTaken(e.damage, target.heroId, target.stoneSkinT > 0, this.t);
            target.hp = applyDamage(target.hp, dmg);
          }
          e.state = 'moving';
        }
      } else if (target) {
        if (dist <= m.attackReach * e.scale) {
          if (e.swingCd <= 1e-9) {
            e.state = 'winding';
            e.timer = m.swingWindupSec;
            e.swingCd = m.swingIntervalSec;
          }
        } else {
          const speed =
            e.speed * (1 - strongestSlow(e.zoneSlowFrac, e.zoneSlowT, e.boltSlowFrac, e.boltSlowT));
          vx = dirX * speed;
          vz = dirZ * speed;
        }
      }

      // Separation from other enemies.
      const n = this.grid.query(e.x, e.z, e.radius * 2.2);
      for (let k = 0; k < n; k++) {
        const j = this.grid.result[k]!;
        if (j === i) continue;
        const o = items[j]!;
        if (o.hp <= 0) continue;
        const dx = e.x - o.x;
        const dz = e.z - o.z;
        const min = e.radius + o.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const f = (min - d) * 5;
          vx += (dx / d) * f;
          vz += (dz / d) * f;
        }
      }
      // Heroes are solid to enemies (a dashing Gale passes through).
      for (const h of this.heroList) {
        if (h.status === 'dead' || h.dashT > 0) continue;
        const dx = e.x - h.x;
        const dz = e.z - h.z;
        const min = e.radius + h.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const f = (min - d) * 8;
          vx += (dx / d) * f;
          vz += (dz / d) * f;
        }
      }
      e.x += (vx + e.kvx) * dt;
      e.z += (vz + e.kvz) * dt;
      e.kvx *= decay;
      e.kvz *= decay;
      if (Math.abs(e.kvx) < 1e-4) e.kvx = 0;
      if (Math.abs(e.kvz) < 1e-4) e.kvz = 0;
      // Enemies stay off the hold platform and inside the map.
      const ring = this.t.ring;
      const minR = hold + e.radius;
      const d = Math.hypot(e.x, e.z);
      if (d < minR && d > 1e-6) {
        e.x *= minR / d;
        e.z *= minR / d;
      } else if (d > ring.mapRadius + 4) {
        e.x *= (ring.mapRadius + 4) / d;
        e.z *= (ring.mapRadius + 4) / d;
      }
    }
  }

  /** Kindle burns. */
  private stepBurns(dt: number): void {
    const items = this.enemies.items;
    for (let i = 0; i < this.enemies.count; i++) {
      const e = items[i]!;
      if (e.burnT <= 0 || e.hp <= 0 || !e.targetable) continue;
      this.damageEnemy(e, e.burnDps * Math.min(dt, e.burnT));
      e.burnT -= dt;
      if (e.burnT <= 1e-9) e.burnT = 0;
    }
  }

  private stepProjectiles(dt: number): void {
    const items = this.projectiles.items;
    const enemies = this.enemies.items;
    const kindle = heroKit('ember', 1, this.t).passive;
    const undertow = heroKit('tide', 1, this.t).passive;
    for (let i = this.projectiles.count - 1; i >= 0; i--) {
      const p = items[i]!;
      const step = p.speed * dt;
      p.x += p.dirX * step;
      p.z += p.dirZ * step;
      p.travelled += step;
      let hit = false;
      const n = this.grid.query(p.x, p.z, this.boltReach);
      for (let k = 0; k < n; k++) {
        const e = enemies[this.grid.result[k]!]!;
        if (!e.targetable || e.hp <= 0) continue;
        const r = e.radius + p.hitRadius;
        if ((e.x - p.x) ** 2 + (e.z - p.z) ** 2 <= r * r) {
          this.damageEnemy(e, p.damage);
          if (e.hp > 0) {
            if (p.kit === 'ember') {
              e.burnT = kindle.burnSec;
              e.burnDps = kindle.burnDps;
            } else if (p.kit === 'tide') {
              e.boltSlowFrac = undertow.slowFrac;
              e.boltSlowT = undertow.slowSec;
            }
          }
          hit = true;
          break;
        }
      }
      if (hit || p.travelled >= p.range) this.projectiles.release(i);
    }
  }

  private removeDeadEnemies(): void {
    const items = this.enemies.items;
    for (let i = this.enemies.count - 1; i >= 0; i--) if (items[i]!.hp <= 0) this.enemies.release(i);
  }

  private emitStatusChanges(): void {
    for (const h of this.heroList) {
      if (h.status === h.prevStatus) continue;
      if (h.status === 'downed') this.events.push({ type: 'heroDowned', id: h.id });
      else if (h.status === 'dead') this.events.push({ type: 'heroDied', id: h.id });
      else this.events.push({ type: 'heroRevived', id: h.id });
      h.prevStatus = h.status;
    }
  }

  private readonly spawnOne = (level: number): boolean => {
    const a = this.rng.next() * Math.PI * 2;
    const r = this.rng.range(this.t.waves.spawnRadiusMin, this.t.waves.spawnRadiusMax);
    return this.enemies.spawn(Math.cos(a) * r, Math.sin(a) * r, level, this.t) !== null;
  };

  private stepWaves(dt: number): void {
    const r = this.waves.step(dt, this.enemies.count, this.heroes.size, this.spawnOne);
    if (r === 'cleared') this.events.push({ type: 'waveCleared', wave: this.waves.wave });
    else if (r === 'started') this.events.push({ type: 'waveStarted', wave: this.waves.wave });
  }

  private checkRunEnd(): void {
    if (this.heroList.length === 0) return;
    for (const h of this.heroList) if (h.status === 'standing') return;
    this.phase = 'ended';
    this.projectiles.clear();
    this.zones.clear();
    this.events.push({
      type: 'runEnded',
      wave: this.waves.wave,
      durationSec: Math.round((this.nowMs - this.startMs) / 1000),
    });
  }
}
