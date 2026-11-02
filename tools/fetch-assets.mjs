// Downloads the KayKit source models (CC0) into assets/kaykit/ at pinned commits.
// assets/ is git-ignored; run `npm run fetch-assets` once after cloning, then `npm run assets`.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKS = [
  {
    dir: 'adventurers',
    repo: 'KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0',
    commit: '672074b73ba276876a19e8816ecdc5241817ab47',
    base: 'addons/kaykit_character_pack_adventures/Characters/gltf',
    files: ['Mage.glb', 'Knight.glb', 'Rogue.glb', 'Rogue_Hooded.glb'],
  },
  {
    dir: 'skeletons',
    repo: 'KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0',
    commit: '15b62b9bad122f72926c10fb14d622c73819fa54',
    base: 'addons/kaykit_character_pack_skeletons/Characters/gltf',
    files: ['Skeleton_Minion.glb', 'Skeleton_Warrior.glb', 'Skeleton_Mage.glb', 'Skeleton_Rogue.glb'],
  },
];

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf;
}

async function main() {
  for (const p of PACKS) {
    const raw = `https://raw.githubusercontent.com/${p.repo}/${p.commit}`;
    const out = join(ROOT, 'assets', 'kaykit', p.dir);
    for (const f of [...p.files.map((x) => `${p.base}/${x}`), 'LICENSE.txt']) {
      const dest = join(out, f.split('/').pop());
      if (existsSync(dest)) {
        console.log(`have ${p.dir}/${f.split('/').pop()}`);
        continue;
      }
      const buf = await download(`${raw}/${f}`, dest);
      const sha = createHash('sha256').update(buf).digest('hex').slice(0, 12);
      console.log(`got  ${p.dir}/${f.split('/').pop()} (${buf.length} bytes, sha256 ${sha})`);
    }
    await writeFile(join(out, 'SOURCE.txt'), `https://github.com/${p.repo}/tree/${p.commit}\n`);
  }
  // Sanity check: GLB magic bytes.
  for (const p of PACKS)
    for (const f of p.files) {
      const b = await readFile(join(ROOT, 'assets', 'kaykit', p.dir, f));
      if (b.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${f} is not a GLB file`);
    }
}

await main();
