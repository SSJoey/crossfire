import * as THREE from 'three';
import {
  ELEMENT_COLOR,
  elementAt,
  HEROES,
  heroKit,
  isHeroId,
  type Element,
  type HeroId,
} from '@crossfire/shared/heroes';
import { assistRange, clampCast } from '@crossfire/shared/rules/abilities';
import { assistTarget, type AimTarget } from '@crossfire/shared/rules/aim';
import { pauseCooldownLeft } from '@crossfire/shared/rules/pause';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG, type HeroStatus, type InputMessage } from '@crossfire/shared/types';
import { debugView } from './debug';
import { FpsOverlay, fpsEnabled } from './hud/fps';
import { el } from './dom';
import { Hud, type HudView } from './hud/hud';
import { clampToMap, rayToGround } from './input/aim';
import { debugEnabled } from './input/cast';
import { Controls } from './input/controls';
import { InputSeq } from './input/keys';
import type { GameRoom } from './net/connection';
import { SnapshotBuffer, type Sample } from './net/interpolation';
import { PerfReporter } from './net/perfReport';
import { Predictor } from './net/prediction';
import type { EnemyStateName, HeroView, RoomState } from './net/state';
import type { Models } from './render/assets';
import { BoltSprite, Pulses, Reticle, ZoneDisc, ZonePreview } from './render/effects';
import { zoneOpacity } from './render/fx';
import { Stage } from './render/scene';
import { zoneTexture } from './render/textures';
import type { Tier } from './render/tiers';
import { EnemyUnit, HeroUnit, type HeroActName } from './render/units';
import { ViewRegistry } from './render/views';

const TICK = 1 / TUNING.tickHz;
const MAX_BOLTS = 256;

interface HeroEntry {
  unit: HeroUnit;
  buf: SnapshotBuffer;
  status: HeroStatus;
  reviveProgress: number;
  lastActSeq: number;
  /** Last synced position (where a Flame step started). */
  lastX: number;
  lastZ: number;
  dashing: boolean;
}

interface EnemyEntry {
  unit: EnemyUnit;
  buf: SnapshotBuffer;
  hp: number;
  state: EnemyStateName;
  scale: number;
  fx: number;
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

interface ZoneEntry {
  disc: ZoneDisc;
  x: number;
  z: number;
  el: Element;
  /** Seconds left at the last patch, and when that patch arrived (ms). */
  remaining: number;
  at: number;
}

function isAct(a: string): a is HeroActName {
  return a === 'attack' || a === 'q' || a === 'e';
}

/**
 * The game view for one player: renders the synced state, predicts the player's own hero and
 * sends its input once per server tick. Lives for the whole connection; runs are reset in place.
 */
export class Game {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly stage: Stage;
  private readonly debug = debugEnabled(location.search);
  private readonly hud = new Hud(this.debug);
  private readonly controls: Controls;
  private readonly predictor = new Predictor();
  private readonly seq = new InputSeq();
  private readonly reticle = new Reticle();
  private readonly preview: ZonePreview;
  private readonly pulses = new Pulses();
  private readonly heroes = new Map<string, HeroEntry>();
  private readonly enemies: ViewRegistry<EnemyEntry>;
  private readonly bolts: ViewRegistry<BoltEntry>;
  private readonly zones: ViewRegistry<ZoneEntry>;
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
    cast: 'none',
    qHeld: false,
  };
  private readonly move = { x: 0, z: 0 };
  private readonly aim = { x: 0, z: 4 };
  private readonly sample: Sample = { x: 0, z: 0, facing: 0 };
  private readonly drawPos = { x: 0, z: 0 };
  private readonly castPos = { x: 0, z: 0 };
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
    hero: 'ember',
    qCd: 0,
    eCd: 0,
    qHeld: false,
    paused: false,
    pausedBy: '',
    myName: '',
    pauseHintSec: 0,
  };
  // ---- pause (stage 1b.3) ----
  private paused = false;
  /** Who paused the open pause ('' = the host page); remembered for the resume. */
  private pausedBy = '';
  private myName = '';
  /** My own pause cooldown ends here (performance.now ms). Cosmetic: the server decides. */
  private pauseBlockedUntil = 0;
  /** Show the "Pause available in N s" hint until here. */
  private pauseHintUntil = 0;
  private myStatus: HeroStatus | null = null;
  private myHero: HeroId = 'ember';
  private sendAcc = 0;
  private sinceSend = 0;
  private lastFrame = 0;
  private raf = 0;
  private running = false;
  private readonly onResize = () => this.stage.resize();
  /** A hidden tab draws no frames: tell the perf reporter to skip the gap frame that follows. */
  private readonly onVisibility = () => {
    if (document.hidden) this.perf.hidden();
  };

  constructor(
    private readonly models: Models,
    private readonly room: GameRoom,
    tier: Tier,
  ) {
    this.canvas = el('canvas', { id: 'game-canvas', attrs: { tabindex: '0', 'aria-label': 'Game view' } });
    this.root = el('div', { className: 'game' }, this.canvas, this.hud.root);
    if (this.fps) this.root.append(this.fps.root);
    this.stage = new Stage(this.canvas);
    const zoneTex = zoneTexture();
    this.preview = new ZonePreview(zoneTex);
    this.stage.scene.add(this.reticle.group, this.preview.mesh, this.pulses.group);
    this.controls = new Controls(this.canvas, this.debug);
    // The server also needs CROSSFIRE_DEBUG=1; otherwise it ignores this.
    this.controls.onDebugHero = (hero) => this.room.send(MSG.debugHero, { hero });
    this.controls.onPause = () => this.requestPause();

    const enemyMax = TUNING.waves.enemyCap + TUNING.client.deathViewSlack;
    this.enemies = new ViewRegistry<EnemyEntry>(
      () => {
        const unit = new EnemyUnit(models.minion, this.stage.glow);
        unit.setShadows(this.enemyShadows);
        this.stage.scene.add(unit.holder);
        return {
          unit,
          buf: new SnapshotBuffer(TUNING.client.snapshotBuffer),
          hp: 0,
          state: 'spawning',
          scale: 1,
          fx: 0,
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
    let zoneLayer = 0;
    this.zones = new ViewRegistry<ZoneEntry>(
      () => {
        const disc = new ZoneDisc(zoneTex, zoneLayer++);
        this.stage.scene.add(disc.mesh);
        return { disc, x: 0, z: 0, el: 'fire', remaining: 0, at: 0 };
      },
      {
        max: TUNING.zones.cap,
        onShow: (v) => {
          v.disc.mesh.visible = true;
        },
        onHide: (v) => {
          v.disc.mesh.visible = false;
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
  /** Tier and fps report for the match log, sent every 10 s during a run. */
  private readonly perf = new PerfReporter();
  private phase = '';

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
    document.addEventListener('visibilitychange', this.onVisibility);
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
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.controls.releaseAll();
  }

  /** Clears everything from the last run (back to the lobby). */
  resetRun(): void {
    this.enemies.releaseAll();
    this.bolts.releaseAll();
    this.zones.releaseAll();
    this.pulses.clear();
    this.preview.hide();
    for (const [id, h] of this.heroes) {
      this.stage.scene.remove(h.unit.holder);
      this.heroes.delete(id);
    }
    this.seenBefore.clear();
    this.myStatus = null;
    this.paused = false;
    this.pausedBy = '';
    this.pauseBlockedUntil = 0;
    this.pauseHintUntil = 0;
    this.controls.releaseAll();
  }

  /** Esc: ask the server to pause, unless my own cooldown is still running (then show a hint). */
  private requestPause(): void {
    if (this.phase !== 'running' || this.paused || !this.myStatus) return;
    const now = performance.now();
    if (pauseCooldownLeft(now, this.pauseBlockedUntil) > 0) {
      this.pauseHintUntil = now + TUNING.pause.hintSec * 1000;
      return;
    }
    this.room.send(MSG.pause, {});
  }

  /** Pause and resume, before this patch's positions are pushed. */
  private onPauseChange(s: RoomState, now: number): void {
    const paused = s.phase === 'running' && s.paused;
    if (paused) this.pausedBy = s.pausedBy;
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      // Nothing is sent while paused; held keys and a latched cast are dropped.
      this.controls.releaseAll();
      return;
    }
    if (s.phase !== 'running') return;
    // Resumed.
    if (this.pausedBy !== '' && this.pausedBy === this.myName)
      this.pauseBlockedUntil = now + TUNING.pause.cooldownSec * 1000;
    this.pausedBy = '';
    this.controls.cast.cancel();
    // Nothing slides across the paused gap; my hero restarts prediction from the server.
    const before = now - TICK * 1000;
    for (const h of this.heroes.values()) h.buf.rebase(before);
    this.enemies.forEachActive((v) => v.buf.rebase(before));
    this.bolts.forEachActive((v) => v.buf.rebase(before));
    this.myStatus = null;
  }

  dispose(): void {
    this.stop();
    this.controls.dispose();
    this.stage.dispose();
    this.root.remove();
  }

  // ---- network ----

  private newHeroEntry(h: HeroView, id: string, myId: string): HeroEntry {
    const hero = isHeroId(h.hero) ? h.hero : 'ember';
    const unit = new HeroUnit(this.models.heroes[hero], hero, this.stage.glow);
    unit.setMine(id === myId);
    unit.setShadows(this.stage.shadows);
    this.stage.scene.add(unit.holder);
    return {
      unit,
      buf: new SnapshotBuffer(TUNING.client.snapshotBuffer),
      status: h.status,
      reviveProgress: 0,
      lastActSeq: h.actSeq,
      lastX: h.x,
      lastZ: h.z,
      dashing: false,
    };
  }

  private onPatch(s: RoomState): void {
    const now = performance.now();
    const myId = this.room.sessionId;
    this.myName = s.heroes.get(myId)?.name ?? s.players.get(myId)?.name ?? '';
    this.onPauseChange(s, now);

    s.heroes.forEach((h, id) => {
      let e = this.heroes.get(id);
      if (e && e.unit.hero !== h.hero) {
        // Debug hero switch: a new body for the new hero.
        this.stage.scene.remove(e.unit.holder);
        e = undefined;
      }
      if (!e) {
        e = this.newHeroEntry(h, id, myId);
        this.heroes.set(id, e);
      }
      if (h.actSeq !== e.lastActSeq) {
        e.lastActSeq = h.actSeq;
        if (isAct(h.act)) this.onAct(e, h, id === myId);
      }
      e.buf.push(now, h.x, h.z, h.facing);
      e.lastX = h.x;
      e.lastZ = h.z;
      e.status = h.status;
      e.dashing = h.dashing;
      e.unit.setStoneSkin(h.stoneSkin);
      const need = h.status === 'dead' ? TUNING.revive.deadReviveSec : TUNING.revive.downedReviveSec;
      e.reviveProgress = h.status === 'standing' ? 0 : Math.min(1, h.reviveProgress / need);
      if (id === myId) this.reconcileMe(h);
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
      v.fx = en.fx;
    });
    for (const id of this.seenBefore) {
      if (this.seenNow.has(id)) continue;
      if (s.phase === 'running') this.enemies.kill(id, TUNING.client.deathAnimSec);
      else this.enemies.release(id);
    }
    this.seenBefore.clear();
    for (const id of this.seenNow) this.seenBefore.add(id);

    s.bolts.forEach((b, id) => {
      const known = this.bolts.get(id);
      const v = known ?? this.bolts.acquire(id);
      if (!v) return;
      if (!known) {
        v.dirX = b.dirX;
        v.dirZ = b.dirZ;
        v.sprite.setElement(elementAt(b.element));
      }
      v.buf.push(now, b.x, b.z, 0);
    });
    this.bolts.forEachActive((_v, id) => {
      if (!s.bolts.get(id)) this.bolts.release(id);
    });

    // Zones do not move: no interpolation, only their time left.
    s.zones.forEach((zn, id) => {
      const v = this.zones.acquire(id);
      if (!v) return;
      v.x = zn.x;
      v.z = zn.z;
      v.el = zn.element;
      v.remaining = zn.remaining;
      v.at = now;
    });
    this.zones.forEachActive((_v, id) => {
      if (!s.zones.get(id)) this.zones.release(id);
    });

    const dbg = debugView();
    dbg.phase = s.phase;
    this.phase = s.phase;
    const me = s.heroes.get(myId);
    dbg.me = me ? { x: me.x, z: me.z, status: me.status, hero: me.hero, eCd: me.eCd } : null;
    dbg.zones = s.zones.size;
    dbg.paused = this.paused;

    const v = this.hudView;
    v.wave = s.wave;
    v.waveBreak = s.waveState === 'break';
    v.horde = s.enemies.size;
    if (me) {
      v.hp = me.hp;
      v.maxHp = me.maxHp;
      v.status = me.status;
      v.bleedOut = me.bleedOut;
      v.hero = this.myHero;
      v.qCd = me.qCd;
      v.eCd = me.eCd;
    }
    let standing = 0;
    s.heroes.forEach((h) => {
      if (h.status === 'standing') standing++;
    });
    v.standing = standing;
    this.findReviveTarget(s, myId);
  }

  /** Something a hero just did: its animation, and the placeholder effect for an E. */
  private onAct(e: HeroEntry, h: HeroView, mine: boolean): void {
    const act = h.act as HeroActName;
    e.unit.act(act);
    if (act !== 'e') return;
    if (h.hero === 'ember') {
      // Flame step: puffs at both ends; another player's hero jumps instead of sliding.
      this.pulses.fire(e.lastX, e.lastZ, ELEMENT_COLOR.fire, 0.3, 1.4, 0.45);
      this.pulses.fire(h.x, h.z, ELEMENT_COLOR.fire, 0.3, 1.6, 0.5);
      if (!mine) e.buf.clear();
    } else if (h.hero === 'tide') {
      this.pulses.fire(h.x, h.z, ELEMENT_COLOR.water, 0.5, heroKit('tide').utility.radius, 0.7);
    } else if (h.hero === 'bastion') {
      this.pulses.fire(h.x, h.z, ELEMENT_COLOR.earth, 0.5, heroKit('bastion').utility.tauntRadius, 0.6);
    }
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

  private reconcileMe(h: HeroView): void {
    if (isHeroId(h.hero) && h.hero !== this.myHero) {
      this.myHero = h.hero;
      this.predictor.setHero(h.hero);
    }
    if (h.status !== 'standing') {
      this.predictor.reset(h.x, h.z);
    } else if (this.myStatus !== 'standing') {
      // Run start or just revived: start predicting from the server position.
      this.predictor.reset(h.x, h.z);
      this.predictor.reconcile(h.x, h.z, h.lastSeq, h.eCd);
      this.stage.snapCamera(h.x, h.z);
    } else {
      this.predictor.reconcile(h.x, h.z, h.lastSeq, h.eCd);
    }
    this.myStatus = h.status;
  }

  private sendInput(): void {
    const inp = this.input;
    const standing = this.myStatus === 'standing';
    this.controls.keys.move(this.move);
    inp.seq = this.seq.next();
    inp.moveX = this.move.x;
    inp.moveZ = this.move.z;
    inp.aimX = this.aim.x;
    inp.aimZ = this.aim.z;
    inp.attack = this.controls.attackHeld;
    inp.revive = this.controls.reviveHeld;
    inp.qHeld = standing && this.controls.cast.qHeld;
    inp.cast = this.controls.cast.take(standing, this.predictor.eReady());
    this.room.send(MSG.input, inp);
    if (standing) this.predictor.applyInput(inp.seq, inp.moveX, inp.moveZ, inp.cast, inp.aimX, inp.aimZ);
    this.sinceSend = 0;
  }

  // ---- frame ----

  private frame(t: number): void {
    this.fps?.frame(t - this.lastFrame, this.hudView.horde, this.tierName);
    const report = this.perf.frame(
      t - this.lastFrame,
      // A pause counts like the lobby: the report window restarts (stage 1b.3).
      this.phase === 'running' && !this.paused,
      this.tierName,
      this.canvas.width,
      this.canvas.height,
      this.stage.renderer.getPixelRatio(),
    );
    if (report) this.room.send(MSG.perf, report);
    const frameDt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;
    // Paused: the camera and the page keep working, but every animation and effect is frozen.
    const paused = this.paused;
    const dt = paused ? 0 : frameDt;
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
      if (this.myStatus && !paused) this.sendInput();
      sends++;
    }
    if (this.sendAcc > TICK) this.sendAcc = 0;

    // Heroes: mine predicted, the others interpolated.
    let meX = 0;
    let meZ = 0;
    for (const [id, h] of this.heroes) {
      if (id === myId && h.status === 'standing' && !paused) {
        this.controls.keys.move(this.move);
        this.predictor.decay(dt);
        this.predictor.renderPos(this.drawPos, this.sinceSend, this.move.x, this.move.z);
        this.predictor.setFacingFromAim(this.aim.x, this.aim.z);
        h.unit.setDashing(this.predictor.dashing || h.dashing);
        h.unit.update(dt, this.drawPos.x, this.drawPos.z, this.predictor.facing, h.status, h.reviveProgress);
        meX = this.drawPos.x;
        meZ = this.drawPos.z;
      } else if (h.buf.sample(id === myId ? Infinity : renderTime, this.sample)) {
        h.unit.setDashing(h.dashing);
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
      e.unit.update(dt, e.x, e.z, this.sample.facing, e.state, e.hp, e.scale, e.fx);
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

    this.zones.forEachActive((z) => {
      // Paused: the time left stays at the last patch's value.
      if (paused) z.at = now;
      const left = z.remaining - (now - z.at) / 1000;
      z.disc.place(z.x, z.z, z.el, zoneOpacity(left, TUNING.zones.durationSec));
    });
    this.pulses.update(dt);

    // Reticle, aim line and the aim-assist target (same rule as the server).
    const standing = this.myStatus === 'standing';
    this.reticle.setVisible(standing);
    if (standing) {
      const range = assistRange(this.myHero);
      this.reticle.update(meX, meZ, this.aim.x, this.aim.z, range);
      const i = TUNING.aim.assistOn
        ? assistTarget(meX, meZ, this.aim.x, this.aim.z, range, TUNING.aim.assistCone, this.aimTargets, n)
        : -1;
      const tgt = i >= 0 ? this.aimTargets[i] : undefined;
      this.reticle.setTarget(!!tgt, tgt?.x, tgt?.z);
    }

    // Q preview: where the zone would land, dim while Q cools down.
    const qHeld = standing && !paused && this.controls.cast.qHeld;
    if (qHeld) {
      clampCast(meX, meZ, this.aim.x, this.aim.z, TUNING.zones.castRange, this.castPos);
      this.preview.show(
        this.castPos.x,
        this.castPos.z,
        HEROES[this.myHero].element,
        this.hudView.qCd <= 1e-9,
      );
    } else this.preview.hide();
    debugView().qPreview = this.preview.visible;

    if (this.myStatus) this.stage.follow(meX, meZ, frameDt);
    const v = this.hudView;
    v.outsideRing = Math.hypot(meX, meZ) > TUNING.ring.radius;
    v.qHeld = qHeld;
    v.paused = paused;
    v.pausedBy = this.pausedBy;
    v.myName = this.myName;
    v.pauseHintSec = now < this.pauseHintUntil ? pauseCooldownLeft(now, this.pauseBlockedUntil) : 0;
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
