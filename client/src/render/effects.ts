import * as THREE from 'three';

const FIRE = 0xff6a2b;

/** A fire bolt: an additive glow sprite with a short trail. Pooled. */
export class BoltSprite {
  readonly group = new THREE.Group();
  private readonly trail: THREE.Sprite;

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
        color: FIRE,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        opacity: 0.7,
      }),
    );
    this.trail.scale.setScalar(0.9);
    this.group.add(core, this.trail);
    this.group.visible = false;
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
