import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { ELEMENT_COLOR, HEROES, heroKit, type HeroId } from '@crossfire/shared/heroes';
import { TUNING } from '@crossfire/shared/tuning';
import type { HeroStatus } from '@crossfire/shared/types';
import type { EnemyStateName } from '../net/state';
import type { ModelSet } from './assets';
import { HERO_ANIM, HERO_CLIP, SKELETON_CLIP } from './clips';
import { statusGlow } from './fx';

interface PlayOptions {
  once?: boolean;
  fade?: number;
  timeScale?: number;
}

/** One mixer per unit; clips are shared between all units of a rig. */
class Animator {
  readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private cur: THREE.AnimationAction | null = null;
  private curName = '';
  private oneShotLeft = 0;

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const c of clips) this.actions.set(c.name, this.mixer.clipAction(c));
  }

  get current(): string {
    return this.curName;
  }

  /** True while a one-shot clip is still playing. */
  get busy(): boolean {
    return this.oneShotLeft > 0;
  }

  duration(name: string): number {
    return this.actions.get(name)?.getClip().duration ?? 0;
  }

  play(name: string, { once = false, fade = 0.15, timeScale = 1 }: PlayOptions = {}): void {
    const a = this.actions.get(name);
    if (!a) return;
    if (this.cur === a && !once) {
      a.timeScale = timeScale;
      return;
    }
    a.reset();
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.timeScale = timeScale;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (this.cur && this.cur !== a && fade > 0) a.crossFadeFrom(this.cur, fade, false);
    else if (this.cur && this.cur !== a) this.cur.stop();
    a.play();
    this.cur = a;
    this.curName = name;
    this.oneShotLeft = once ? a.getClip().duration / timeScale : 0;
  }

  update(dt: number): void {
    if (this.oneShotLeft > 0) this.oneShotLeft = Math.max(0, this.oneShotLeft - dt);
    this.mixer.update(dt);
  }

  stopAll(): void {
    this.mixer.stopAllAction();
    this.cur = null;
    this.curName = '';
    this.oneShotLeft = 0;
  }
}

function makeUnit(set: ModelSet): { holder: THREE.Group; model: THREE.Object3D; anim: Animator } {
  const model = cloneSkinned(set.scene);
  model.scale.setScalar(set.scale);
  const holder = new THREE.Group();
  holder.add(model);
  return { holder, model, anim: new Animator(model, set.clips) };
}

function setCastShadow(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = on;
  });
}

function flatRing(inner: number, outer: number, mat: THREE.Material, segments = 48): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, segments), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.04;
  return m;
}

const ARC_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ARC_FRAG = /* glsl */ `
uniform float progress;
uniform vec3 color;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float a = atan(p.x, p.y) / 6.2831853 + 0.5;
  if (a > progress) discard;
  gl_FragColor = vec4(color, 0.95);
}`;

/** Shared hero ring geometry and materials. */
const youMat = new THREE.MeshBasicMaterial({
  color: 0xf2c14e,
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  toneMapped: false,
});

const MOVING_SPEED = 0.6;
const TRAIL = 3;

const auraGeo = new THREE.CircleGeometry(0.75, 32);
const shellGeo = new THREE.CylinderGeometry(0.78, 0.78, 1.9, 20, 1, true);

function glowMat(glow: THREE.Texture, color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    map: glow,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/** What the hero last did, as synced in `HeroState.act`. */
export type HeroActName = 'attack' | 'q' | 'e';

/**
 * A hero: model, animation from its synced status and actions, its element aura and ground
 * markers, and the placeholder E visuals (stone shell, dash trail).
 */
export class HeroUnit {
  readonly holder: THREE.Group;
  readonly hero: HeroId;
  private readonly anim: Animator;
  private readonly model: THREE.Object3D;
  private readonly youRing: THREE.Mesh;
  private readonly downRing: THREE.Mesh;
  private readonly downMat: THREE.MeshBasicMaterial;
  private readonly arc: THREE.Mesh;
  private readonly arcMat: THREE.ShaderMaterial;
  private status: HeroStatus = 'standing';
  private readonly last = new THREE.Vector2();
  private speed = 0;
  private time = 0;
  private hasPos = false;
  private readonly aura: THREE.Mesh;
  private readonly shell: THREE.Mesh;
  private readonly shellMat: THREE.MeshBasicMaterial;
  private readonly trail: THREE.Sprite[] = [];
  private stoneSkin = false;
  private dashing = false;
  private readonly moveDir = new THREE.Vector2(0, 1);

  constructor(set: ModelSet, hero: HeroId, glow: THREE.Texture) {
    this.hero = hero;
    const u = makeUnit(set);
    this.holder = u.holder;
    this.model = u.model;
    this.anim = u.anim;
    this.youRing = flatRing(0.62, 0.8, youMat);
    this.youRing.visible = false;
    this.downMat = new THREE.MeshBasicMaterial({
      color: 0xff3a2a,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      toneMapped: false,
    });
    this.downRing = flatRing(0.9, 1.05, this.downMat);
    this.downRing.visible = false;
    this.arcMat = new THREE.ShaderMaterial({
      uniforms: { progress: { value: 0 }, color: { value: new THREE.Color(0xf2c14e) } },
      vertexShader: ARC_VERT,
      fragmentShader: ARC_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.arc = flatRing(1.1, 1.3, this.arcMat, 64);
    this.arc.position.y = 0.05;
    this.arc.visible = false;
    const color = ELEMENT_COLOR[HEROES[hero].element];
    this.aura = new THREE.Mesh(auraGeo, glowMat(glow, color, 0.75));
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.position.y = 0.035;
    // Stone skin: a faint earth-coloured shell around Bastion.
    this.shellMat = new THREE.MeshBasicMaterial({
      color: ELEMENT_COLOR.earth,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.shell.position.y = 0.95;
    this.shell.visible = false;
    // Gust dash: a few air-coloured glows behind the hero.
    for (let i = 0; i < TRAIL; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: ELEMENT_COLOR.air,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          opacity: 0.7 - i * 0.2,
        }),
      );
      sp.scale.setScalar(1.3 - i * 0.25);
      sp.visible = false;
      this.trail.push(sp);
    }
    // Markers live outside the rotating model so they stay flat and centred.
    this.holder.add(this.aura, this.youRing, this.downRing, this.arc, this.shell, ...this.trail);
    this.anim.play(HERO_CLIP.idle, { fade: 0 });
  }

  /** Stone skin is up (synced). */
  setStoneSkin(on: boolean): void {
    this.stoneSkin = on;
  }

  /** A Gust dash is under way (synced, or predicted for my own hero). */
  setDashing(on: boolean): void {
    this.dashing = on;
  }

  /** Plays the clip for something the hero just did (a new `act` from the server). */
  act(kind: HeroActName): void {
    if (this.status !== 'standing') return;
    const a = HERO_ANIM[this.hero];
    if (kind === 'attack') {
      const kit = heroKit(this.hero);
      const interval = 'bolt' in kit ? kit.bolt.intervalSec : kit.melee.intervalSec;
      const base = 'bolt' in kit ? 2 : 1.8;
      const d = this.anim.duration(a.attack);
      this.anim.play(a.attack, { once: true, fade: 0.08, timeScale: Math.max(base, d / interval) });
    } else if (kind === 'q') {
      this.anim.play(a.q, { once: true, fade: 0.08, timeScale: 1.6 });
    } else if (a.e) {
      // The dash clip is squeezed into the dash itself.
      const d = this.anim.duration(a.e);
      const ts = this.hero === 'gale' ? Math.max(1, d / heroKit('gale').utility.durationSec) : 1.6;
      this.anim.play(a.e, { once: true, fade: 0.05, timeScale: ts });
    }
  }

  setMine(mine: boolean): void {
    this.youRing.visible = mine;
  }

  setShadows(on: boolean): void {
    setCastShadow(this.model, on);
  }

  update(dt: number, x: number, z: number, facing: number, status: HeroStatus, reviveProgress: number): void {
    this.time += dt;
    if (this.hasPos && dt > 0) {
      const v = Math.hypot(x - this.last.x, z - this.last.y) / dt;
      this.speed += (v - this.speed) * (1 - Math.exp(-12 * dt));
    }
    const mdx = x - this.last.x;
    const mdz = z - this.last.y;
    if (this.hasPos && mdx * mdx + mdz * mdz > 1e-6) this.moveDir.set(mdx, mdz).normalize();
    this.last.set(x, z);
    this.hasPos = true;
    this.holder.position.set(x, 0, z);
    this.model.rotation.y = facing;

    const standing = status === 'standing';
    this.aura.visible = standing;
    this.shell.visible = standing && this.stoneSkin;
    if (this.shell.visible) this.shellMat.opacity = 0.22 + 0.1 * Math.sin(this.time * 5);
    for (let i = 0; i < TRAIL; i++) {
      const sp = this.trail[i]!;
      sp.visible = standing && this.dashing;
      if (sp.visible) sp.position.set(-this.moveDir.x * (i + 1) * 0.7, 1, -this.moveDir.y * (i + 1) * 0.7);
    }

    if (status !== this.status) this.onStatus(status);
    this.status = status;
    if (status === 'standing') {
      if (!this.anim.busy) {
        this.anim.play(this.speed > MOVING_SPEED ? HERO_CLIP.run : HERO_CLIP.idle, {
          timeScale: this.speed > MOVING_SPEED ? Math.max(0.8, this.speed / 5.2) : 1,
        });
      }
    } else if (status === 'downed' && !this.anim.busy && this.anim.current !== HERO_CLIP.lieIdle) {
      this.anim.play(HERO_CLIP.lieIdle, { fade: 0.2 });
    }

    const down = status !== 'standing';
    this.downRing.visible = down;
    if (down) {
      this.downMat.opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(this.time * 6));
      this.downMat.color.setHex(status === 'dead' ? 0x9a1a14 : 0xff3a2a);
    }
    this.arc.visible = down && reviveProgress > 0;
    this.arcMat.uniforms.progress!.value = reviveProgress;
    this.anim.update(dt);
  }

  private onStatus(next: HeroStatus): void {
    if (next === 'downed') this.anim.play(HERO_CLIP.lieDown, { once: true, fade: 0.1 });
    else if (next === 'dead') this.anim.play(HERO_CLIP.death, { once: true, fade: 0.2 });
    else if (next === 'standing')
      this.anim.play(HERO_CLIP.standUp, { once: true, fade: 0.1, timeScale: 1.4 });
  }

  /** Back to a fresh standing hero (new run). */
  reset(): void {
    this.status = 'standing';
    this.hasPos = false;
    this.speed = 0;
    this.anim.stopAll();
    this.anim.play(HERO_CLIP.idle, { fade: 0 });
  }
}

/** A skeleton minion; reused from a pool. */
export class EnemyUnit {
  readonly holder: THREE.Group;
  private readonly anim: Animator;
  private readonly model: THREE.Object3D;
  private readonly baseScale: number;
  private state: EnemyStateName = 'spawning';
  private prevHp = 0;
  private hitCd = 0;
  private dying = false;
  private dieT = 0;
  private readonly last = new THREE.Vector2();
  private speed = 0;
  private hasPos = false;
  /** One small glow above the head for the most important status effect (fx bits). */
  private readonly glow: THREE.Sprite;
  private readonly glowMat: THREE.SpriteMaterial;

  constructor(set: ModelSet, glow: THREE.Texture) {
    const u = makeUnit(set);
    this.holder = u.holder;
    this.model = u.model;
    this.anim = u.anim;
    this.baseScale = set.scale;
    this.glowMat = new THREE.SpriteMaterial({
      map: glow,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.85,
    });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.scale.setScalar(0.7);
    this.glow.position.y = 1.95;
    this.glow.visible = false;
    this.holder.add(this.glow);
    this.holder.visible = false;
  }

  setShadows(on: boolean): void {
    setCastShadow(this.model, on);
  }

  /** Taken from the pool for a new enemy. */
  show(): void {
    this.holder.visible = true;
    this.holder.position.y = 0;
    this.dying = false;
    this.dieT = 0;
    this.state = 'spawning';
    this.prevHp = 0;
    this.hitCd = 0;
    this.speed = 0;
    this.hasPos = false;
    this.anim.stopAll();
    const spawnSec = TUNING.minion.spawnSec;
    const d = this.anim.duration(SKELETON_CLIP.spawn);
    this.anim.play(SKELETON_CLIP.spawn, { once: true, fade: 0, timeScale: d > 0 ? d / spawnSec : 1 });
  }

  hide(): void {
    this.glow.visible = false;
    this.holder.visible = false;
    this.anim.stopAll();
  }

  die(): void {
    this.glow.visible = false;
    this.dying = true;
    this.dieT = 0;
    this.anim.play(SKELETON_CLIP.death, { once: true, fade: 0.1 });
  }

  /** Called for dying enemies: the death plays, then the body sinks. */
  updateDying(dt: number): void {
    this.dieT += dt;
    if (this.dieT > 1.4) this.holder.position.y -= dt * 0.9;
    this.anim.update(dt);
  }

  update(
    dt: number,
    x: number,
    z: number,
    facing: number,
    state: EnemyStateName,
    hp: number,
    scale: number,
    fx = 0,
  ): void {
    if (this.dying) return;
    const c = statusGlow(fx);
    this.glow.visible = c !== null;
    if (c !== null) {
      this.glowMat.color.setHex(c);
      this.glow.position.y = 1.95 * scale;
    }
    if (this.hasPos && dt > 0) {
      const v = Math.hypot(x - this.last.x, z - this.last.y) / dt;
      this.speed += (v - this.speed) * (1 - Math.exp(-10 * dt));
    }
    this.last.set(x, z);
    this.hasPos = true;
    this.holder.position.set(x, this.holder.position.y, z);
    this.model.rotation.y = facing;
    this.model.scale.setScalar(this.baseScale * scale);

    this.hitCd -= dt;
    if (state === 'winding' && this.state !== 'winding') {
      this.anim.play(SKELETON_CLIP.attack, { once: true, fade: 0.08, timeScale: 1.2 });
    } else if (hp < this.prevHp && this.hitCd <= 0 && state === 'moving' && !this.anim.busy) {
      this.anim.play(SKELETON_CLIP.hit, { once: true, fade: 0.08, timeScale: 1.4 });
      this.hitCd = 0.6;
    } else if (state === 'moving' && !this.anim.busy) {
      if (this.speed > 0.3) {
        const ts = Math.min(2, Math.max(0.6, (this.speed / TUNING.minion.speed) * 1.15));
        this.anim.play(SKELETON_CLIP.walk, { timeScale: ts });
      } else {
        this.anim.play(SKELETON_CLIP.idle, { fade: 0.2 });
      }
    }
    this.state = state;
    this.prevHp = hp;
    this.anim.update(dt);
  }
}
