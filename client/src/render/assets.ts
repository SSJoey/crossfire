import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HEROES, HERO_IDS, type HeroId } from '@crossfire/shared/heroes';
import { MODEL_FILES } from './clips';
import { applyTint } from './tint';

/** Target heights in metres (look test). */
const HERO_HEIGHT: Readonly<Record<HeroId, number>> = { ember: 1.85, bastion: 1.85, tide: 1.8, gale: 1.8 };
const MINION_HEIGHT = 1.6;

export interface ModelSet {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Uniform scale that gives the model its target height. */
  scale: number;
}

export interface Models {
  heroes: Record<HeroId, ModelSet>;
  minion: ModelSet;
}

function heightScale(root: THREE.Object3D, target: number): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  return h > 0.05 && h < 500 ? target / h : 1;
}

function prepare(scene: THREE.Group): void {
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      // Skinned meshes animate outside their bind-pose bounds.
      o.frustumCulled = false;
    }
  });
}

/** Loads the slimmed KayKit models (see tools/assets.mjs). */
export async function loadModels(onProgress: (fraction: number) => void): Promise<Models> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const heroFiles = HERO_IDS.map((id) => MODEL_FILES.heroes[id]);
  const files = [...heroFiles, MODEL_FILES.heroAnims, MODEL_FILES.minion, MODEL_FILES.skeletonAnims];
  let done = 0;
  const loaded = await Promise.all(
    files.map(async (f) => {
      const g = await loader.loadAsync(`/models/${f}`);
      onProgress(++done / files.length);
      return g;
    }),
  );
  const n = HERO_IDS.length;
  const heroAnims = loaded[n]!;
  const minion = loaded[n + 1]!;
  const skelAnims = loaded[n + 2]!;
  const heroes = {} as Record<HeroId, ModelSet>;
  HERO_IDS.forEach((id, i) => {
    const scene = loaded[i]!.scene;
    prepare(scene);
    // Tide's blue recolour: each hero file has its own material, so tinting it once is enough.
    const tint = HEROES[id].tint;
    if (tint !== null) applyTint(scene, tint);
    heroes[id] = { scene, clips: heroAnims.animations, scale: heightScale(scene, HERO_HEIGHT[id]) };
  });
  prepare(minion.scene);
  return {
    heroes,
    minion: {
      scene: minion.scene,
      clips: skelAnims.animations,
      scale: heightScale(minion.scene, MINION_HEIGHT),
    },
  };
}
