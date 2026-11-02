import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { HERO_CLIPS, MODEL_FILES, SKELETON_CLIPS } from '../../../client/src/render/clips';

/**
 * Checks the committed output of tools/assets.mjs (client/public/models/), so it runs on a
 * fresh clone without the git-ignored KayKit sources. The manifest records the source sizes.
 */
const OUT = join(import.meta.dirname, '../../../client/public/models');

interface Manifest {
  models: Record<string, { source: string; sourceBytes: number; bytes: number; clips: string[] }>;
}

let io: NodeIO;
let manifest: Manifest;

beforeAll(async () => {
  await MeshoptDecoder.ready;
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
  });
  manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as Manifest;
});

async function read(file: string) {
  return io.read(join(OUT, file));
}

describe('KayKit asset pipeline output', () => {
  it('writes every model file the client loads', () => {
    for (const f of Object.values(MODEL_FILES)) expect(existsSync(join(OUT, f)), f).toBe(true);
  });

  it('character files hold mesh and skeleton but no clips', async () => {
    for (const f of [MODEL_FILES.hero, MODEL_FILES.minion]) {
      const root = (await read(f)).getRoot();
      expect(root.listMeshes().length, f).toBeGreaterThan(0);
      expect(root.listSkins().length, f).toBe(1);
      expect(root.listAnimations().length, f).toBe(0);
    }
  });

  it('each rig has one shared animation file with exactly the kept clips and no meshes', async () => {
    const cases: [string, readonly string[]][] = [
      [MODEL_FILES.heroAnims, HERO_CLIPS],
      [MODEL_FILES.skeletonAnims, SKELETON_CLIPS],
    ];
    for (const [f, clips] of cases) {
      const root = (await read(f)).getRoot();
      expect(root.listMeshes().length, f).toBe(0);
      const names = root.listAnimations().map((a) => a.getName());
      expect([...names].sort(), f).toEqual([...clips].sort());
    }
  });

  it('every clip the client plays exists in the output', () => {
    const all = Object.values(manifest.models).flatMap((m) => m.clips);
    for (const c of [...HERO_CLIPS, ...SKELETON_CLIPS]) expect(all, c).toContain(c);
  });

  it('geometry is compressed and every output is smaller than its source', async () => {
    for (const [file, m] of Object.entries(manifest.models)) {
      const bytes = statSync(join(OUT, file)).size;
      expect(bytes, file).toBe(m.bytes);
      expect(bytes, file).toBeLessThan(m.sourceBytes);
    }
    const used = (await read(MODEL_FILES.hero))
      .getRoot()
      .listExtensionsUsed()
      .map((e) => e.extensionName);
    expect(used).toContain('EXT_meshopt_compression');
  });

  it('the whole model set stays small enough for a quick join on Wi-Fi', () => {
    const total = Object.values(MODEL_FILES).reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
    expect(total).toBeLessThan(2_000_000);
  });
});
