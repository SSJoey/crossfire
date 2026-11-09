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
  '1H_Melee_Attack_Chop',
  'Dualwield_Melee_Attack_Chop',
  '1H_Ranged_Shoot',
  'Spellcast_Raise',
  'Block',
  'Dodge_Forward',
];
const SKELETON_CLIPS = [
  'Spawn_Ground_Skeletons',
  'Walking_D_Skeletons',
  'Idle_Combat',
  '1H_Melee_Attack_Chop',
  'Hit_A',
  'Death_A',
];

/**
 * The four heroes (stage 1b) and the Skeleton Minion. Hero props must match `props` in
 * shared/heroes.ts (tests/unit/tools/assets.test.ts checks it): body parts (named after
 * `body`) always stay, and every prop not listed there is dropped.
 */
const JOBS = [
  // Ember holds only the staff: the KayKit Mage also carries a wand and two spellbooks.
  {
    out: 'Mage.glb',
    src: 'adventurers/Mage.glb',
    kind: 'character',
    body: 'Mage_',
    dropParts: ['1H_Wand', 'Spellbook', 'Spellbook_open'],
  },
  // Bastion: one-handed sword and the round shield.
  {
    out: 'Knight.glb',
    src: 'adventurers/Knight.glb',
    kind: 'character',
    body: 'Knight_',
    dropParts: ['1H_Sword_Offhand', '2H_Sword', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield'],
  },
  // Tide: the one-handed crossbow (the model is tinted blue at runtime).
  {
    out: 'Rogue_Hooded.glb',
    src: 'adventurers/Rogue_Hooded.glb',
    kind: 'character',
    body: 'Rogue_',
    dropParts: ['2H_Crossbow', 'Knife', 'Knife_Offhand', 'Throwable'],
  },
  // Gale: twin knives.
  {
    out: 'Rogue.glb',
    src: 'adventurers/Rogue.glb',
    kind: 'character',
    body: 'Rogue_',
    dropParts: ['1H_Crossbow', '2H_Crossbow', 'Throwable'],
  },
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

/** Removes named mesh parts (unused props). Returns their triangle count. */
function dropParts(root, names, file) {
  let triangles = 0;
  for (const name of names) {
    const node = root.listNodes().find((n) => n.getName() === name && n.getMesh());
    if (!node) throw new Error(`${file}: no part named ${name}`);
    for (const p of node.getMesh().listPrimitives()) {
      const idx = p.getIndices();
      triangles += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    }
    node.setMesh(null);
  }
  return triangles;
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
      const dropped = job.dropParts ?? [];
      const droppedTriangles = dropParts(root, dropped, job.src);
      // Props left on the model (not body parts), recorded for the props check.
      const keptProps = job.body
        ? root
            .listNodes()
            .filter((n) => n.getMesh() && !n.getName().startsWith(job.body))
            .map((n) => n.getName())
        : [];
      await doc.transform(prune(), dedup());
      // Body parts and bone-attached props become one skinned mesh: fewer draw calls per unit.
      merge = { dropped, droppedTriangles, keptProps, ...mergeSkinnedParts(doc, basename(job.out, '.glb')) };
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
