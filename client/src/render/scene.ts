import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TUNING } from '@crossfire/shared/tuning';
import { dirtTexture, glowTexture, groundTexture, ringGlowTexture } from './textures';
import { pixelRatioFor, TIERS, type Tier } from './tiers';

const SKY = 0x1c2622;

/**
 * Renderer, camera, lights and the static arena: ground, the hold platform and the range ring.
 * Props, torches and the flag are the art pass (stage 1g).
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly glow = glowTexture();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly sun: THREE.DirectionalLight;
  private readonly shadowCasters: THREE.Object3D[] = [];
  private tier: Tier = 'medium';
  private readonly brazierFlame: THREE.Sprite;
  private readonly camOffset = new THREE.Vector3(
    TUNING.client.cameraOffset.x,
    TUNING.client.cameraOffset.y,
    TUNING.client.cameraOffset.z,
  );
  private readonly camTarget = new THREE.Vector3();
  private time = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 30, 72);
    this.camera = new THREE.PerspectiveCamera(TUNING.client.cameraFov, 1, 0.1, 200);
    this.camera.position.copy(this.camOffset);
    this.camera.lookAt(0, 0, 0);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x3a2f22, 1.15));
    this.sun = new THREE.DirectionalLight(0xffefd2, 2.5);
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 80 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.brazierFlame = this.buildArena();
  }

  private buildArena(): THREE.Sprite {
    const ringR = TUNING.ring.radius;
    const gtex = groundTexture();
    gtex.wrapS = gtex.wrapT = THREE.RepeatWrapping;
    gtex.repeat.set(16, 16);
    gtex.anisotropy = 8;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(170, 170),
      new THREE.MeshStandardMaterial({ map: gtex, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const dirt = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({
        map: dirtTexture(),
        transparent: true,
        depthWrite: false,
        roughness: 1,
      }),
    );
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.01;
    dirt.receiveShadow = true;
    this.scene.add(dirt);

    // Outside the ring: tinted red (heroes lose health there).
    const danger = new THREE.Mesh(
      new THREE.RingGeometry(ringR, 85, 128, 1),
      new THREE.MeshBasicMaterial({ color: 0x3d0b0e, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    danger.rotation.x = -Math.PI / 2;
    danger.position.y = 0.015;
    this.scene.add(danger);

    const edge = new THREE.Mesh(
      new THREE.RingGeometry(ringR - 0.09, ringR + 0.09, 180),
      new THREE.MeshBasicMaterial({
        color: 0xffa23a,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.03;
    const edgeGlow = new THREE.Mesh(
      new THREE.RingGeometry(ringR - 0.9, ringR + 0.9, 180),
      new THREE.MeshBasicMaterial({
        color: 0xff8a2a,
        map: ringGlowTexture(),
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    edgeGlow.rotation.x = -Math.PI / 2;
    edgeGlow.position.y = 0.025;
    this.scene.add(edge, edgeGlow);

    // Hold point: a two-tier stone platform with a brazier (radius matches TUNING.ring.holdRadius).
    const stone = new THREE.MeshStandardMaterial({ color: 0x8b8578, roughness: 0.95, flatShading: true });
    const darkStone = new THREE.MeshStandardMaterial({ color: 0x5e5a52, roughness: 1, flatShading: true });
    const hold = new THREE.Group();
    const r = TUNING.ring.holdRadius;
    const tier1 = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.3, 0.32, 12), stone);
    tier1.position.y = 0.16;
    const tier2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.63, r * 0.7, 0.24, 10), stone);
    tier2.position.y = 0.44;
    const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.3, 0.45, 9), darkStone);
    brazier.position.y = 0.78;
    for (const m of [tier1, tier2, brazier]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.shadowCasters.push(m);
    }
    const flame = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glow,
        color: 0xff5a10,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    flame.scale.setScalar(1.1);
    flame.position.y = 1.35;
    const light = new THREE.PointLight(0xff8a3a, 22, 16, 2);
    light.position.y = 1.7;
    hold.add(tier1, tier2, brazier, flame, light);
    this.scene.add(hold);
    return flame;
  }

  applyTier(tier: Tier): void {
    this.tier = tier;
    const t = TIERS[tier];
    this.renderer.shadowMap.enabled = t.shadows;
    this.sun.castShadow = t.shadows;
    for (const m of this.shadowCasters) m.castShadow = t.shadows;
    // Shadow maps are compiled into materials: force a recompile.
    this.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) m.needsUpdate = true;
    });
    this.resize();
  }

  get shadows(): boolean {
    return TIERS[this.tier].shadows;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = pixelRatioFor(this.tier, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 58 : TUNING.client.cameraFov;
    this.camera.updateProjectionMatrix();
  }

  /** Keeps the camera over the followed point, with a little easing. */
  follow(x: number, z: number, dt: number): void {
    const k = 1 - Math.exp(-8 * dt);
    this.camTarget.x += (x - this.camTarget.x) * k;
    this.camTarget.z += (z - this.camTarget.z) * k;
    this.camera.position.set(
      this.camTarget.x + this.camOffset.x,
      this.camOffset.y,
      this.camTarget.z + this.camOffset.z,
    );
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z);
    this.sun.position.set(this.camTarget.x + 12, 26, this.camTarget.z + 9);
    this.sun.target.position.set(this.camTarget.x, 0, this.camTarget.z);
  }

  snapCamera(x: number, z: number): void {
    this.camTarget.set(x, 0, z);
    this.follow(x, z, 1);
  }

  render(dt: number): void {
    this.time += dt;
    this.brazierFlame.scale.setScalar(1.05 + Math.sin(this.time * 9) * 0.08);
    if (TIERS[this.tier].bloom) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
