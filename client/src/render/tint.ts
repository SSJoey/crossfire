import * as THREE from 'three';

type Tintable = THREE.Material & { color?: THREE.Color };

/**
 * Multiplies the colour of every material under `root` by `hex`, once per material even when
 * meshes share it (Tide's blue recolour; KayKit uses one atlas material, so the skin is tinted too).
 */
export function applyTint(root: THREE.Object3D, hex: number): void {
  const tint = new THREE.Color(hex);
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as Tintable[]) {
      if (done.has(m) || !m.color) continue;
      done.add(m);
      m.color.multiply(tint);
    }
  });
}
