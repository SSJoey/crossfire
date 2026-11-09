import * as THREE from 'three';
import { ELEMENT_COLOR, type Element } from '@crossfire/shared/heroes';
import { TUNING } from '@crossfire/shared/tuning';

const WHITE = new THREE.Color(0xffffff);

/** A bolt: an additive glow sprite with a short trail in its element colour. Pooled. */
export class BoltSprite {
  readonly group = new THREE.Group();
  private readonly trail: THREE.Sprite;
  private readonly core: THREE.Sprite;

  constructor(glow: THREE.Texture) {
    const core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: 0xffd08a,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    core.scale.setScalar(0.55);
    this.trail = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: ELEMENT_COLOR.fire,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: 0.7,
      }),
    );
    this.trail.scale.setScalar(0.9);
    this.core = core;
    this.group.add(core, this.trail);
    this.group.visible = false;
  }

  /** Colours a newly shown bolt: trail in the element colour, a paler core. */
  setElement(el: Element): void {
    this.trail.material.color.setHex(ELEMENT_COLOR[el]);
    this.core.material.color.setHex(ELEMENT_COLOR[el]).lerp(WHITE, 0.6);
  }

  place(x: number, z: number, dirX: number, dirZ: number): void {
    this.group.position.set(x, 1.1, z);
    this.trail.position.set(-dirX * 0.35, 0, -dirZ * 0.35);
  }
}

/** Aim reticle on the ground, a dashed aim line from the hero, and the aim-assist target ring. */
export class Reticle {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly line: THREE.Line;
  private readonly linePos: THREE.BufferAttribute;
  private readonly lineDist: THREE.BufferAttribute;
  private readonly target: THREE.Mesh;

  constructor() {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.44, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.05;

    const geo = new THREE.BufferGeometry();
    this.linePos = new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage);
    this.lineDist = new THREE.BufferAttribute(new Float32Array(2), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.linePos);
    geo.setAttribute('lineDistance', this.lineDist);
    this.line = new THREE.Line(
      geo,
      new THREE.LineDashedMaterial({
        color: 0xffffff,
        dashSize: 0.35,
        gapSize: 0.25,
        transparent: true,
        opacity: 0.55,
        toneMapped: false,
      }),
    );
    this.line.frustumCulled = false;

    this.target = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.68, 32),
      new THREE.MeshBasicMaterial({
        color: 0xff6a2b,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.target.rotation.x = -Math.PI / 2;
    this.target.position.y = 0.045;
    this.target.visible = false;

    this.group.add(this.ring, this.line, this.target);
  }

  /** `range` limits the aim line to the attack range. */
  update(heroX: number, heroZ: number, aimX: number, aimZ: number, range: number): void {
    this.ring.position.x = aimX;
    this.ring.position.z = aimZ;
    let dx = aimX - heroX;
    let dz = aimZ - heroZ;
    const len = Math.hypot(dx, dz);
    if (len > range) {
      dx *= range / len;
      dz *= range / len;
    }
    const p = this.linePos.array as Float32Array;
    p[0] = heroX;
    p[1] = 0.06;
    p[2] = heroZ;
    p[3] = heroX + dx;
    p[4] = 0.06;
    p[5] = heroZ + dz;
    this.linePos.needsUpdate = true;
    const d = this.lineDist.array as Float32Array;
    d[0] = 0;
    d[1] = Math.min(len, range);
    this.lineDist.needsUpdate = true;
  }

  setTarget(visible: boolean, x = 0, z = 0): void {
    this.target.visible = visible;
    if (visible) {
      this.target.position.x = x;
      this.target.position.z = z;
    }
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }
}

const zoneGeo = new THREE.CircleGeometry(TUNING.zones.radius, 48);

function zoneMat(tex: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/** A Q zone on the ground in its element colour (look test). Pooled. */
export class ZoneDisc {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(tex: THREE.Texture, layer: number) {
    this.mat = zoneMat(tex);
    this.mesh = new THREE.Mesh(zoneGeo, this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    // A tiny height step per pooled disc keeps overlapping zones from flickering.
    this.mesh.position.y = 0.05 + (layer % 32) * 0.002;
    this.mesh.visible = false;
  }

  place(x: number, z: number, el: Element, opacity: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mat.color.setHex(ELEMENT_COLOR[el]);
    this.mat.opacity = opacity * 0.9;
  }
}

/** Where a held Q will land (clamped to cast range); dim while Q is cooling down. */
export class ZonePreview {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(tex: THREE.Texture) {
    this.mat = zoneMat(tex);
    this.mesh = new THREE.Mesh(zoneGeo, this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.06;
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  show(x: number, z: number, el: Element, ready: boolean): void {
    this.mesh.visible = true;
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mat.color.setHex(ELEMENT_COLOR[el]);
    this.mat.opacity = ready ? 0.6 : 0.2;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

interface Pulse {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  life: number;
  r0: number;
  r1: number;
}

const pulseGeo = new THREE.RingGeometry(0.85, 1, 48);

/**
 * Expanding, fading ground rings for one-shot effects (blink puffs, Mending wave).
 * A fixed pool; the oldest ring is reused when all are busy.
 */
export class Pulses {
  readonly group = new THREE.Group();
  private readonly items: Pulse[] = [];
  private next = 0;

  constructor(count = 24) {
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(pulseGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.07;
      mesh.visible = false;
      this.group.add(mesh);
      this.items.push({ mesh, mat, t: 0, life: 0, r0: 0, r1: 0 });
    }
  }

  fire(x: number, z: number, color: number, r0: number, r1: number, life: number): void {
    const p = this.items[this.next]!;
    this.next = (this.next + 1) % this.items.length;
    p.mesh.position.x = x;
    p.mesh.position.z = z;
    p.mat.color.setHex(color);
    p.t = 0;
    p.life = life;
    p.r0 = r0;
    p.r1 = r1;
    p.mesh.visible = true;
  }

  update(dt: number): void {
    for (const p of this.items) {
      if (!p.mesh.visible) continue;
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) {
        p.mesh.visible = false;
        continue;
      }
      p.mesh.scale.setScalar(p.r0 + (p.r1 - p.r0) * (1 - (1 - k) * (1 - k)));
      p.mat.opacity = 0.9 * (1 - k);
    }
  }

  clear(): void {
    for (const p of this.items) p.mesh.visible = false;
  }
}
