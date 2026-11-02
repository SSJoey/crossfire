import { assistTarget } from '@crossfire/shared/rules/aim';
import { applyDamage } from '@crossfire/shared/rules/health';
import { stepHero } from '@crossfire/shared/rules/movement';
import { downIfDepleted, stepRevive } from '@crossfire/shared/rules/revive';
import { ringHealth } from '@crossfire/shared/rules/ring';
import { acceptSeq, isStale } from '@crossfire/shared/rules/validation';
import { TUNING, type Tuning } from '@crossfire/shared/tuning';
import type { InputMessage, WaveState } from '@crossfire/shared/types';
import { EnemyPool } from './enemies';
import { createHero, resetHero, type SimHero } from './heroes';
import { ProjectilePool } from './projectiles';
import { Rng } from './rng';
import { SpatialGrid } from './spatial';
import { WaveDirector } from './waves';

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
  private readonly grid: SpatialGrid;
  private readonly waves: WaveDirector;
  private readonly rng: Rng;
  phase: WorldPhase = 'idle';
  /** Events produced by the last step(). */
  readonly events: WorldEvent[] = [];
  private startMs = 0;
  private nowMs = 0;
  kills = 0;

  constructor(opts: WorldOptions = {}) {
    this.t = opts.tuning ?? TUNING;
    this.dt = 1 / this.t.tickHz;
    this.rng = new Rng(opts.seed ?? 1);
    this.enemies = new EnemyPool(this.t.waves.enemyCap);
    this.projectiles = new ProjectilePool(PROJECTILE_CAP);
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

  addHero(id: string, name: string): SimHero {
    const used = new Set([...this.heroes.values()].map((h) => h.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const h = createHero(id, name, slot, this.t);
    this.heroes.set(id, h);
    this.heroList = [...this.heroes.values()];
    return h;
  }

  removeHero(id: string): void {
    this.heroes.delete(id);
    this.heroList = [...this.heroes.values()];
  }

  /** Starts a fresh run with the current heroes. */
  start(nowMs: number): void {
    this.enemies.clear();
    this.projectiles.clear();
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
    this.stepEnemies(dt);
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

  private stepHeroes(dt: number): void {
    const bolt = this.t.ember.bolt;
    for (const h of this.heroList) {
      const inp = h.input;
      if (isStale(h.lastInputMs, this.nowMs, this.t.net.staleInputMs)) {
        inp.moveX = 0;
        inp.moveZ = 0;
        inp.attack = false;
        inp.revive = false;
      }
      h.attackCd = Math.max(0, h.attackCd - dt);
      if (h.status !== 'standing') {
        h.holdingRevive = false;
        continue;
      }
      stepHero(h, inp.moveX, inp.moveZ, h.speed, dt, this.t.ring);
      const ax = inp.aimX - h.x;
      const az = inp.aimZ - h.z;
      if (ax * ax + az * az > 1e-6) h.facing = Math.atan2(ax, az);
      h.holdingRevive = inp.revive;

      if (inp.attack && h.attackCd <= 1e-9) {
        let tx = inp.aimX;
        let tz = inp.aimZ;
        if (this.t.aim.assistOn) {
          const i = assistTarget(
            h.x,
            h.z,
            inp.aimX,
            inp.aimZ,
            bolt.range,
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
        this.projectiles.spawn(h.id, h.x, h.z, dirX, dirZ, bolt.speed, bolt.range, bolt.damage);
        h.attackCd = bolt.intervalSec;
      }

      h.hp = ringHealth(h.hp, h.maxHp, h.x, h.z, dt, h.status, this.t.ring);
    }
  }

  private rebuildGrid(): void {
    this.grid.clear();
    const items = this.enemies.items;
    for (let i = 0; i < this.enemies.count; i++) this.grid.insert(i, items[i]!.x, items[i]!.z);
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

  private stepEnemies(dt: number): void {
    const m = this.t.minion;
    const items = this.enemies.items;
    const hold = this.t.ring.holdRadius;
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

      const target = this.nearestStanding(e.x, e.z);
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
          e.facing = Math.atan2(dirX, dirZ);
        }
      }

      if (e.state === 'winding') {
        e.timer -= dt;
        if (e.timer <= 1e-9) {
          if (target && target.status === 'standing' && dist <= m.hitReach * e.scale) {
            target.hp = applyDamage(target.hp, e.damage);
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
          vx = dirX * e.speed;
          vz = dirZ * e.speed;
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
      // Heroes are solid to enemies.
      for (const h of this.heroList) {
        if (h.status === 'dead') continue;
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
      e.x += vx * dt;
      e.z += vz * dt;
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

  private stepProjectiles(dt: number): void {
    const items = this.projectiles.items;
    const enemies = this.enemies.items;
    const reach = this.t.ember.bolt.hitRadius + this.t.minion.radius * this.t.minion.levelScaleCap;
    for (let i = this.projectiles.count - 1; i >= 0; i--) {
      const p = items[i]!;
      const step = p.speed * dt;
      p.x += p.dirX * step;
      p.z += p.dirZ * step;
      p.travelled += step;
      let hit = false;
      const n = this.grid.query(p.x, p.z, reach);
      for (let k = 0; k < n; k++) {
        const e = enemies[this.grid.result[k]!]!;
        if (!e.targetable || e.hp <= 0) continue;
        const r = e.radius + this.t.ember.bolt.hitRadius;
        if ((e.x - p.x) ** 2 + (e.z - p.z) ** 2 <= r * r) {
          e.hp = applyDamage(e.hp, p.damage);
          if (e.hp <= 0) {
            e.targetable = false;
            this.kills++;
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
    this.events.push({
      type: 'runEnded',
      wave: this.waves.wave,
      durationSec: Math.round((this.nowMs - this.startMs) / 1000),
    });
  }
}
