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

type Box = [number[], number[]];

interface Manifest {
  models: Record<
    string,
    {
      source: string;
      sourceBytes: number;
      bytes: number;
      clips: string[];
      /** Character files only: what the body-part merge did. */
      merge?: {
        partsBefore: number;
        drawCallsAfter: number;
        trianglesBefore: number;
        trianglesAfter: number;
        /** Bind-pose bounds of the whole character before and after merging. */
        boxBefore: Box;
        boxAfter: Box;
      };
    }
  >;
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

  it('each character is one skinned mesh with one draw call per material', async () => {
    const limits: [string, number][] = [
      [MODEL_FILES.hero, 1],
      [MODEL_FILES.minion, 2],
    ];
    for (const [f, maxDrawCalls] of limits) {
      const root = (await read(f)).getRoot();
      const meshNodes = root.listNodes().filter((n) => n.getMesh());
      expect(meshNodes.length, f).toBe(1);
      expect(meshNodes[0]!.getSkin(), f).toBeTruthy();
      const prims = meshNodes[0]!.getMesh()!.listPrimitives();
      expect(prims.length, f).toBeLessThanOrEqual(maxDrawCalls);
      const mats = new Set(prims.map((p) => p.getMaterial()));
      expect(mats.size, f).toBe(prims.length);
      expect(manifest.models[f]!.merge!.drawCallsAfter, f).toBe(prims.length);
    }
  });

  it('the merge keeps every triangle and the same bind-pose shape', () => {
    for (const f of [MODEL_FILES.hero, MODEL_FILES.minion]) {
      const m = manifest.models[f]!.merge!;
      expect(m.partsBefore, f).toBeGreaterThan(m.drawCallsAfter);
      expect(m.trianglesAfter, f).toBe(m.trianglesBefore);
      for (let k = 0; k < 2; k++)
        for (let a = 0; a < 3; a++)
          expect(m.boxAfter[k]![a]!, `${f} box`).toBeCloseTo(m.boxBefore[k]![a]!, 3);
    }
  });

  it('every vertex is bound to a real joint with weights summing to 1', async () => {
    for (const f of [MODEL_FILES.hero, MODEL_FILES.minion]) {
      const root = (await read(f)).getRoot();
      const joints = root.listSkins()[0]!.listJoints().length;
      const prim = root.listMeshes()[0]!.listPrimitives()[0]!;
      const J = prim.getAttribute('JOINTS_0')!;
      const W = prim.getAttribute('WEIGHTS_0')!;
      const j: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < J.getCount(); i++) {
        J.getElement(i, j);
        W.getElement(i, w);
        const sum = w.reduce((s, x) => s + x, 0);
        expect(Math.abs(sum - 1), `${f} vertex ${i} weights`).toBeLessThan(0.02);
        for (let c = 0; c < 4; c++) if (w[c]! > 0) expect(j[c]!, `${f} vertex ${i}`).toBeLessThan(joints);
      }
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
