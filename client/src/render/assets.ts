import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MODEL_FILES } from './clips';

/** Target heights in metres (look test). */
const TARGET_HEIGHT = { hero: 1.85, minion: 1.6 } as const;

export interface ModelSet {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Uniform scale that gives the model its target height. */
  scale: number;
}

export interface Models {
  hero: ModelSet;
  minion: ModelSet;
}

function heightScale(root: THREE.Object3D, target: number): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const h = box.max.y - box.min.y;
  return h > 0.05 && h < 500 ? target / h : 1;
}

/** Loads the slimmed KayKit models (see tools/assets.mjs). */
export async function loadModels(onProgress: (fraction: number) => void): Promise<Models> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const files = [MODEL_FILES.hero, MODEL_FILES.heroAnims, MODEL_FILES.minion, MODEL_FILES.skeletonAnims];
  let done = 0;
  const [hero, heroAnims, minion, skelAnims] = await Promise.all(
    files.map(async (f) => {
      const g = await loader.loadAsync(`/models/${f}`);
      onProgress(++done / files.length);
      return g;
    }),
  );
  for (const g of [hero!, minion!]) {
    g.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        // Skinned meshes animate outside their bind-pose bounds.
        o.frustumCulled = false;
      }
    });
  }
  return {
    hero: {
      scene: hero!.scene,
      clips: heroAnims!.animations,
      scale: heightScale(hero!.scene, TARGET_HEIGHT.hero),
    },
    minion: {
      scene: minion!.scene,
      clips: skelAnims!.animations,
      scale: heightScale(minion!.scene, TARGET_HEIGHT.minion),
    },
  };
}
