import * as THREE from 'three';
import { assistTarget, type AimTarget } from '@crossfire/shared/rules/aim';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG, type HeroStatus, type InputMessage } from '@crossfire/shared/types';
import { debugView } from './debug';
import { FpsOverlay, fpsEnabled } from './hud/fps';
import { el } from './dom';
import { Hud, type HudView } from './hud/hud';
import { clampToMap, rayToGround } from './input/aim';
import { Controls } from './input/controls';
import { InputSeq } from './input/keys';
import type { GameRoom } from './net/connection';
import { SnapshotBuffer, type Sample } from './net/interpolation';
import { Predictor } from './net/prediction';
import type { EnemyStateName, RoomState } from './net/state';
import type { Models } from './render/assets';
import { BoltSprite, Reticle } from './render/effects';
import { Stage } from './render/scene';
import type { Tier } from './render/tiers';
import { EnemyUnit, HeroUnit } from './render/units';
import { ViewRegistry } from './render/views';

const TICK = 1 / TUNING.tickHz;
const MAX_BOLTS = 256;

interface HeroEntry {
  unit: HeroUnit;
  buf: SnapshotBuffer;
  status: HeroStatus;
  reviveProgress: number;
}

interface EnemyEntry {
  unit: EnemyUnit;
  buf: SnapshotBuffer;
  hp: number;
  state: EnemyStateName;
  scale: number;
  /** Position drawn this frame (for aim assist). */
  x: number;
  z: number;
}

interface BoltEntry {
  sprite: BoltSprite;
  buf: SnapshotBuffer;
  dirX: number;
  dirZ: number;
}

/**
 * The game view for one player: renders the synced state, predicts the player's own hero and
 * sends its input once per server tick. Lives for the whole connection; runs are reset in place.
 */
export class Game {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly stage: Stage;
  private readonly hud = new Hud();
  private readonly controls: Controls;
  private readonly predictor = new Predictor();
  private readonly seq = new InputSeq();
  private readonly reticle = new Reticle();
  private readonly heroes = new Map<string, HeroEntry>();
  private readonly enemies: ViewRegistry<EnemyEntry>;
  private readonly bolts: ViewRegistry<BoltEntry>;
  private readonly seenNow = new Set<string>();
  private readonly seenBefore = new Set<string>();
  private readonly aimTargets: (AimTarget & { e: EnemyEntry | null })[] = [];
  private readonly input: InputMessage = {
    seq: 0,
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 0,
    attack: false,
    revive: false,
  };
  private readonly move = { x: 0, z: 0 };
  private readonly aim = { x: 0, z: 4 };
  private readonly sample: Sample = { x: 0, z: 0, facing: 0 };
  private readonly drawPos = { x: 0, z: 0 };
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly hudView: HudView = {
    wave: 0,
    waveBreak: false,
    horde: 0,
    hp: 0,
    maxHp: 0,
    status: 'standing',
    bleedOut: 0,
    revivedFrac: 0,
    outsideRing: false,
    canRevive: '',
    revivingFrac: 0,
    standing: 0,
  };
  private myStatus: HeroStatus | null = null;
  private sendAcc = 0;
  private sinceSend = 0;
  private lastFrame = 0;
  private raf = 0;
  private running = false;
  private readonly onResize = () => this.stage.resize();

  constructor(
    private readonly models: Models,
    private readonly room: GameRoom,
    tier: Tier,
  ) {
    this.canvas = el('canvas', { id: 'game-canvas', attrs: { tabindex: '0', 'aria-label': 'Game view' } });
    this.root = el('div', { className: 'game' }, this.canvas, this.hud.root);
    if (this.fps) this.root.append(this.fps.root);
    this.stage = new Stage(this.canvas);
    this.stage.scene.add(this.reticle.group);
    this.controls = new Controls(this.canvas);

    const enemyMax = TUNING.waves.enemyCap + TUNING.client.deathViewSlack;
    this.enemies = new ViewRegistry<EnemyEntry>(
      () => {
        const unit = new EnemyUnit(models.minion);
        unit.setShadows(this.enemyShadows);
        this.stage.scene.add(unit.holder);
        return {
          unit,
          buf: new SnapshotBuffer(TUNING.client.snapshotBuffer),
          hp: 0,
          state: 'spawning',
          scale: 1,
          x: 0,
          z: 0,
        };
      },
      {
        max: enemyMax,
        onShow: (v) => {
          v.buf.clear();
          v.unit.show();
        },
        onHide: (v) => v.unit.hide(),
        onDie: (v) => v.unit.die(),
      },
    );
    this.bolts = new ViewRegistry<BoltEntry>(
      () => {
        const sprite = new BoltSprite(this.stage.glow);
        this.stage.scene.add(sprite.group);
        return { sprite, buf: new SnapshotBuffer(TUNING.client.snapshotBuffer), dirX: 0, dirZ: 1 };
      },
      {
        max: MAX_BOLTS,
        onShow: (v) => {
          v.buf.clear();
          v.sprite.group.visible = true;
        },
        onHide: (v) => {
          v.sprite.group.visible = false;
        },
      },
    );
    for (let i = 0; i < enemyMax; i++) this.aimTargets.push({ x: 0, z: 0, targetable: false, e: null });

    this.setTier(tier);
    room.onStateChange((s) => this.onPatch(s));
  }

  private enemyShadows = false;
  private tierName: Tier = 'medium';
  /** Performance readout, only with ?fps=1. */
  private readonly fps = fpsEnabled(location.search) ? new FpsOverlay() : null;

  /** Enemies cast shadows on High only (as in the look test); the arena and heroes on Medium too. */
  setTier(tier: Tier): void {
    this.stage.applyTier(tier);
    this.tierName = tier;
    this.enemyShadows = tier === 'high';
    const heroShadows = this.stage.shadows;
    for (const h of this.heroes.values()) h.unit.setShadows(heroShadows);
    this.enemies.forEachActive((v) => v.unit.setShadows(this.enemyShadows));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    window.addEventListener('resize', this.onResize);
    this.stage.resize();
    this.lastFrame = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
    this.canvas.focus();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.controls.releaseAll();
  }

  /** Clears everything from the last run (back to the lobby). */
  resetRun(): void {
    this.enemies.releaseAll();
    this.bolts.releaseAll();
    for (const [id, h] of this.heroes) {
      this.stage.scene.remove(h.unit.holder);
      this.heroes.delete(id);
    }
    this.seenBefore.clear();
    this.myStatus = null;
    this.controls.releaseAll();
  }

  dispose(): void {
    this.stop();
    this.controls.dispose();
    this.stage.dispose();
    this.root.remove();
  }

  // ---- network ----

  private onPatch(s: RoomState): void {
    const now = performance.now();
    const myId = this.room.sessionId;

    s.heroes.forEach((h, id) => {
      let e = this.heroes.get(id);
      if (!e) {
        const unit = new HeroUnit(this.models.hero);
        unit.setMine(id === myId);
        unit.setShadows(this.stage.shadows);
        this.stage.scene.add(unit.holder);
        e = {
          unit,
          buf: new SnapshotBuffer(TUNING.client.snapshotBuffer),
          status: h.status,
          reviveProgress: 0,
        };
        this.heroes.set(id, e);
      }
      e.buf.push(now, h.x, h.z, h.facing);
      e.status = h.status;
      const need = h.status === 'dead' ? TUNING.revive.deadReviveSec : TUNING.revive.downedReviveSec;
      e.reviveProgress = h.status === 'standing' ? 0 : Math.min(1, h.reviveProgress / need);
      if (id === myId) this.reconcileMe(h.x, h.z, h.lastSeq, h.status);
    });
    for (const [id, e] of this.heroes) {
      if (!s.heroes.get(id)) {
        this.stage.scene.remove(e.unit.holder);
        this.heroes.delete(id);
      }
    }

    // Enemies: new ids take a pooled view; ids that vanished during a run died.
    this.seenNow.clear();
    s.enemies.forEach((en, id) => {
      this.seenNow.add(id);
      const v = this.enemies.acquire(id);
      if (!v) return;
      v.buf.push(now, en.x, en.z, en.facing);
      v.hp = en.hp;
      v.state = en.state;
      v.scale = en.scale;
    });
    for (const id of this.seenBefore) {
      if (this.seenNow.has(id)) continue;
      if (s.phase === 'running') this.enemies.kill(id, TUNING.client.deathAnimSec);
      else this.enemies.release(id);
    }
    this.seenBefore.clear();
    for (const id of this.seenNow) this.seenBefore.add(id);

    // Bolts: a new bolt next to a hero plays that hero's cast animation.
    s.bolts.forEach((b, id) => {
      const known = this.bolts.get(id);
      const v = known ?? this.bolts.acquire(id);
      if (!v) return;
      if (!known) {
        v.dirX = b.dirX;
        v.dirZ = b.dirZ;
        this.castFrom(s, b.x, b.z);
      }
      v.buf.push(now, b.x, b.z, 0);
    });
    this.bolts.forEachActive((_v, id) => {
      if (!s.bolts.get(id)) this.bolts.release(id);
    });

    const dbg = debugView();
    dbg.phase = s.phase;
    const me = s.heroes.get(myId);
    dbg.me = me ? { x: me.x, z: me.z, status: me.status } : null;

    const v = this.hudView;
    v.wave = s.wave;
    v.waveBreak = s.waveState === 'break';
    v.horde = s.enemies.size;
    if (me) {
      v.hp = me.hp;
      v.maxHp = me.maxHp;
      v.status = me.status;
      v.bleedOut = me.bleedOut;
    }
    let standing = 0;
    s.heroes.forEach((h) => {
      if (h.status === 'standing') standing++;
    });
    v.standing = standing;
    this.findReviveTarget(s, myId);
  }

  private castFrom(s: RoomState, x: number, z: number): void {
    let best: HeroEntry | undefined;
    let bestD = 1.5 * 1.5;
    s.heroes.forEach((h, id) => {
      const d = (h.x - x) ** 2 + (h.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = this.heroes.get(id);
      }
    });
    best?.unit.shoot();
  }

  /** The body I would revive if I hold F: the nearest downed or dead hero within reach. */
  private findReviveTarget(s: RoomState, myId: string): void {
    const v = this.hudView;
    v.canRevive = '';
    v.revivingFrac = 0;
    v.revivedFrac = this.heroes.get(myId)?.reviveProgress ?? 0;
    const me = s.heroes.get(myId);
    if (!me || me.status !== 'standing') return;
    let bestD = TUNING.revive.radius ** 2;
    s.heroes.forEach((h, id) => {
      if (id === myId || h.status === 'standing') return;
      const d = (h.x - me.x) ** 2 + (h.z - me.z) ** 2;
      if (d <= bestD) {
        bestD = d;
        v.canRevive = h.name;
        v.revivingFrac = this.controls.reviveHeld ? (this.heroes.get(id)?.reviveProgress ?? 0) : 0;
      }
    });
  }

  private reconcileMe(x: number, z: number, lastSeq: number, status: HeroStatus): void {
    if (status !== 'standing') {
      this.predictor.reset(x, z);
    } else if (this.myStatus !== 'standing') {
      // Run start or just revived: start predicting from the server position.
      this.predictor.reset(x, z);
      this.stage.snapCamera(x, z);
    } else {
      this.predictor.reconcile(x, z, lastSeq);
    }
    this.myStatus = status;
  }

  private sendInput(): void {
    const inp = this.input;
    this.controls.keys.move(this.move);
    inp.seq = this.seq.next();
    inp.moveX = this.move.x;
    inp.moveZ = this.move.z;
    inp.aimX = this.aim.x;
    inp.aimZ = this.aim.z;
    inp.attack = this.controls.attackHeld;
    inp.revive = this.controls.reviveHeld;
    this.room.send(MSG.input, inp);
    if (this.myStatus === 'standing') this.predictor.applyInput(inp.seq, inp.moveX, inp.moveZ);
    this.sinceSend = 0;
  }

  // ---- frame ----

  private frame(t: number): void {
    this.fps?.frame(t - this.lastFrame, this.hudView.horde, this.tierName);
    const dt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;
    const now = performance.now();
    const renderTime = now - TUNING.client.interpDelayMs;
    const myId = this.room.sessionId;

    this.updateAim();

    // One input per server tick.
    this.sendAcc += dt;
    this.sinceSend += dt;
    let sends = 0;
    while (this.sendAcc >= TICK && sends < 3) {
      this.sendAcc -= TICK;
      if (this.myStatus) this.sendInput();
      sends++;
    }
    if (this.sendAcc > TICK) this.sendAcc = 0;

    // Heroes: mine predicted, the others interpolated.
    let meX = 0;
    let meZ = 0;
    for (const [id, h] of this.heroes) {
      if (id === myId && h.status === 'standing') {
        this.controls.keys.move(this.move);
        this.predictor.decay(dt);
        this.predictor.renderPos(this.drawPos, this.sinceSend, this.move.x, this.move.z);
        this.predictor.setFacingFromAim(this.aim.x, this.aim.z);
        h.unit.update(dt, this.drawPos.x, this.drawPos.z, this.predictor.facing, h.status, h.reviveProgress);
        meX = this.drawPos.x;
        meZ = this.drawPos.z;
      } else if (h.buf.sample(id === myId ? Infinity : renderTime, this.sample)) {
        h.unit.update(dt, this.sample.x, this.sample.z, this.sample.facing, h.status, h.reviveProgress);
        if (id === myId) {
          meX = this.sample.x;
          meZ = this.sample.z;
        }
      }
    }

    let n = 0;
    this.enemies.forEachActive((e) => {
      if (!e.buf.sample(renderTime, this.sample)) return;
      e.x = this.sample.x;
      e.z = this.sample.z;
      e.unit.update(dt, e.x, e.z, this.sample.facing, e.state, e.hp, e.scale);
      const a = this.aimTargets[n++];
      if (a) {
        a.x = e.x;
        a.z = e.z;
        a.targetable = e.state !== 'spawning';
        a.e = e;
      }
    });
    this.enemies.update(dt);
    this.enemies.forEachDying((e) => e.unit.updateDying(dt));

    this.bolts.forEachActive((b) => {
      if (b.buf.sample(renderTime, this.sample)) b.sprite.place(this.sample.x, this.sample.z, b.dirX, b.dirZ);
    });

    // Reticle, aim line and the aim-assist target (same rule as the server).
    const standing = this.myStatus === 'standing';
    this.reticle.setVisible(standing);
    if (standing) {
      const range = TUNING.ember.bolt.range;
      this.reticle.update(meX, meZ, this.aim.x, this.aim.z, range);
      const i = TUNING.aim.assistOn
        ? assistTarget(meX, meZ, this.aim.x, this.aim.z, range, TUNING.aim.assistCone, this.aimTargets, n)
        : -1;
      const tgt = i >= 0 ? this.aimTargets[i] : undefined;
      this.reticle.setTarget(!!tgt, tgt?.x, tgt?.z);
    }

    if (this.myStatus) this.stage.follow(meX, meZ, dt);
    const v = this.hudView;
    v.outsideRing = Math.hypot(meX, meZ) > TUNING.ring.radius;
    this.hud.update(v);
    this.stage.render(dt);
  }

  private updateAim(): void {
    this.ndc.set(this.controls.ndc.x, this.controls.ndc.y);
    this.ray.setFromCamera(this.ndc, this.stage.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    if (rayToGround(o.x, o.y, o.z, d.x, d.y, d.z, this.aim)) clampToMap(this.aim, TUNING.ring.mapRadius);
  }
}
