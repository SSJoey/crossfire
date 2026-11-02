// Slims the KayKit source models for the browser (run `npm run fetch-assets` first).
// - Character files keep mesh + skeleton, no clips, merged into one skinned mesh
//   (one draw call per material, see merge-skinned.mjs).
// - Each rig gets one shared animation file with only the clips the game plays.
// - Geometry and animation data are compressed with EXT_meshopt_compression.
// Writes client/public/models/*.glb and manifest.json (committed).
import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { mergeSkinnedParts } from './merge-skinned.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'kaykit');
const OUT = join(ROOT, 'client', 'public', 'models');

// Keep in sync with client/src/render/clips.ts (tests/unit/tools/assets.test.ts checks it).
const HERO_CLIPS = [
  'Idle',
  'Running_A',
  'Spellcast_Shoot',
  'Hit_A',
  'Lie_Down',
  'Lie_Idle',
  'Lie_StandUp',
  'Death_A',
];
const SKELETON_CLIPS = [
  'Spawn_Ground_Skeletons',
  'Walking_D_Skeletons',
  'Idle_Combat',
  '1H_Melee_Attack_Chop',
  'Hit_A',
  'Death_A',
];

/** Stage 1a: Ember (Mage) for everyone, Skeleton Minion as the only enemy. */
const JOBS = [
  { out: 'Mage.glb', src: 'adventurers/Mage.glb', kind: 'character' },
  { out: 'hero-anims.glb', src: 'adventurers/Mage.glb', kind: 'anims', clips: HERO_CLIPS },
  { out: 'Skeleton_Minion.glb', src: 'skeletons/Skeleton_Minion.glb', kind: 'character' },
  { out: 'skeleton-anims.glb', src: 'skeletons/Skeleton_Minion.glb', kind: 'anims', clips: SKELETON_CLIPS },
];

/** Accessors referenced by nothing but the root (left behind by removed clips). */
function disposeOrphanAccessors(root) {
  for (const a of root.listAccessors()) {
    if (a.listParents().every((p) => p.propertyType === 'Root')) a.dispose();
  }
}

/** Removes a clip with its channels and samplers (Animation.dispose alone leaves them). */
function disposeClip(a) {
  for (const c of a.listChannels()) c.dispose();
  for (const s of a.listSamplers()) s.dispose();
  a.dispose();
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

  await mkdir(OUT, { recursive: true });
  const manifest = { generatedBy: 'tools/assets.mjs', models: {} };

  for (const job of JOBS) {
    const srcPath = join(SRC, job.src);
    const doc = await io.read(srcPath);
    const root = doc.getRoot();

    let merge;
    if (job.kind === 'character') {
      for (const a of root.listAnimations()) disposeClip(a);
      disposeOrphanAccessors(root);
      await doc.transform(prune(), dedup());
      // Body parts and bone-attached props become one skinned mesh: fewer draw calls per unit.
      merge = mergeSkinnedParts(doc, basename(job.out, '.glb'));
      await doc.transform(prune(), weld());
    } else {
      const have = new Set(root.listAnimations().map((a) => a.getName()));
      const missing = job.clips.filter((c) => !have.has(c));
      if (missing.length) throw new Error(`${job.src} lacks clips: ${missing.join(', ')}`);
      for (const a of root.listAnimations()) if (!job.clips.includes(a.getName())) disposeClip(a);
      for (const n of root.listNodes()) {
        n.setMesh(null);
        n.setSkin(null);
      }
      for (const m of root.listMeshes()) m.dispose();
      for (const s of root.listSkins()) s.dispose();
      disposeOrphanAccessors(root);
      await doc.transform(resample(), prune({ keepLeaves: true }), dedup());
    }
    // One quantization volume for the whole character keeps a single shared skin.
    const volume = job.kind === 'character' ? 'scene' : 'mesh';
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: volume }));
    // Quantization gives the mesh an adjusted copy of its skin; drop the unused original.
    for (const s of root.listSkins()) {
      if (s.listParents().every((p) => p.propertyType === 'Root')) s.dispose();
    }
    disposeOrphanAccessors(root);

    const outPath = join(OUT, job.out);
    await io.write(outPath, doc);
    const clips = root.listAnimations().map((a) => a.getName());
    manifest.models[job.out] = {
      source: job.src,
      sourceBytes: statSync(srcPath).size,
      bytes: statSync(outPath).size,
      clips,
      ...(merge ? { merge } : {}),
    };
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    console.log(
      `${basename(outPath).padEnd(20)} ${kb(statSync(srcPath).size).padStart(8)} -> ${kb(statSync(outPath).size).padStart(7)}  ${clips.length} clips${merge ? `, ${merge.partsBefore} parts -> ${merge.drawCallsAfter} draw call(s)` : ''}`,
    );
  }
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

await main();
