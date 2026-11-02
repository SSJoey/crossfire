// Merges a KayKit character's parts into one skinned mesh with one primitive per material.
//
// KayKit characters are split into skinned body parts (arms, body, head, legs) plus rigid props
// parented to bones (hat, cape, staff, ...). Each part is a separate draw call. Here:
// - skinned parts keep their joints and weights;
// - each prop is bound rigidly to its bone (weight 1), with its vertices moved into bind space;
// - everything sharing a material becomes one primitive on the first skinned node.
// Uses three.js's skinning convention (bind matrix = the mesh node's world matrix), which is
// what GLTFLoader does: world = Σ w · boneWorld · inverseBind · meshWorld · v.

// ---- 4x4 column-major matrix helpers (glTF / gl-matrix layout) ----

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) throw new Error('Singular matrix in merge');
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

function point(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Normal transform: inverse-transpose of the upper 3x3, renormalised. */
function normalFn(m) {
  const inv = invert(m);
  return (x, y, z) => {
    // transpose(inv) applied to (x, y, z)
    const nx = inv[0] * x + inv[1] * y + inv[2] * z;
    const ny = inv[4] * x + inv[5] * y + inv[6] * z;
    const nz = inv[8] * x + inv[9] * y + inv[10] * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
}

function emptyBox() {
  return [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
}

function grow(box, p) {
  for (let a = 0; a < 3; a++) {
    box[0][a] = Math.min(box[0][a], p[a]);
    box[1][a] = Math.max(box[1][a], p[a]);
  }
}

const round = (box) => box.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5));

/** Linear blend skinning at the rest pose: where a vertex is drawn before any animation. */
function skinAtRest(skinMats, p, j, w) {
  const o = [0, 0, 0];
  for (let c = 0; c < 4; c++) {
    if (!w[c]) continue;
    const q = point(skinMats[j[c]], p[0], p[1], p[2]);
    o[0] += w[c] * q[0];
    o[1] += w[c] * q[1];
    o[2] += w[c] * q[2];
  }
  return o;
}

/**
 * Merges all mesh parts of the (single-skin) character in `doc`. Returns stats for the manifest.
 */
export function mergeSkinnedParts(doc, name) {
  const root = doc.getRoot();
  const skins = root.listSkins();
  if (skins.length !== 1) throw new Error(`${name}: expected 1 skin, found ${skins.length}`);
  const skin = skins[0];
  const joints = skin.listJoints();
  const jointIndex = new Map(joints.map((j, i) => [j, i]));
  const ibmAcc = skin.getInverseBindMatrices();
  const ibm = joints.map((_, i) => ibmAcc.getElement(i, []));
  const skinMats = joints.map((j, i) => mul(j.getWorldMatrix(), ibm[i]));

  const parts = root.listNodes().filter((n) => n.getMesh());
  const target = parts.find((n) => n.getSkin() === skin);
  if (!target) throw new Error(`${name}: no skinned part`);
  const M = target.getWorldMatrix();
  const invM = invert(M);

  // Collect vertices per material, in order of first appearance.
  const groups = new Map();
  let trianglesBefore = 0;
  const boxBefore = emptyBox();
  const tmp = { p: [], n: [], uv: [], j: [], w: [] };

  for (const node of parts) {
    const W = node.getWorldMatrix();
    let toBind; // part vertex -> merged bind-space vertex
    let rigidJoint = -1;
    if (node.getSkin()) {
      if (node.getSkin() !== skin) throw new Error(`${name}: ${node.getName()} uses another skin`);
      toBind = mul(invM, W);
    } else {
      // A rigid prop: bind it to the nearest ancestor that is a joint.
      let b = node.getParentNode();
      while (b && !jointIndex.has(b)) b = b.getParentNode();
      if (!b) throw new Error(`${name}: ${node.getName()} is not under any joint`);
      rigidJoint = jointIndex.get(b);
      toBind = mul(mul(mul(invM, invert(ibm[rigidJoint])), invert(b.getWorldMatrix())), W);
    }
    const nrm = normalFn(toBind);

    for (const prim of node.getMesh().listPrimitives()) {
      if (prim.getMode() !== 4) throw new Error(`${name}: ${node.getName()} is not a triangle list`);
      const mat = prim.getMaterial();
      if (!groups.has(mat)) groups.set(mat, { pos: [], nor: [], uv: [], jnt: [], wgt: [], idx: [] });
      const g = groups.get(mat);
      const P = prim.getAttribute('POSITION');
      const N = prim.getAttribute('NORMAL');
      const T = prim.getAttribute('TEXCOORD_0');
      const J = prim.getAttribute('JOINTS_0');
      const Wt = prim.getAttribute('WEIGHTS_0');
      const base = g.pos.length / 3;
      for (let i = 0; i < P.getCount(); i++) {
        P.getElement(i, tmp.p);
        // "Before": exactly where the original part is drawn at rest.
        if (rigidJoint >= 0) grow(boxBefore, point(W, tmp.p[0], tmp.p[1], tmp.p[2]));
        else {
          J.getElement(i, tmp.j);
          Wt.getElement(i, tmp.w);
          grow(boxBefore, skinAtRest(skinMats, point(W, tmp.p[0], tmp.p[1], tmp.p[2]), tmp.j, tmp.w));
        }
        g.pos.push(...point(toBind, tmp.p[0], tmp.p[1], tmp.p[2]));
        if (N) {
          N.getElement(i, tmp.n);
          g.nor.push(...nrm(tmp.n[0], tmp.n[1], tmp.n[2]));
        } else g.nor.push(0, 1, 0);
        if (T) {
          T.getElement(i, tmp.uv);
          g.uv.push(tmp.uv[0], tmp.uv[1]);
        } else g.uv.push(0, 0);
        if (rigidJoint >= 0) {
          g.jnt.push(rigidJoint, 0, 0, 0);
          g.wgt.push(1, 0, 0, 0);
        } else {
          g.jnt.push(...tmp.j);
          g.wgt.push(...tmp.w);
        }
      }
      const I = prim.getIndices();
      const count = I ? I.getCount() : P.getCount();
      for (let k = 0; k < count; k++) g.idx.push(base + (I ? I.getScalar(k) : k));
      trianglesBefore += count / 3;
    }
  }

  // Build the merged mesh.
  const buffer = root.listBuffers()[0];
  const mesh = doc.createMesh(name);
  let trianglesAfter = 0;
  const boxAfter = emptyBox();
  for (const [mat, g] of groups) {
    const vcount = g.pos.length / 3;
    const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const prim = doc
      .createPrimitive()
      .setMaterial(mat)
      .setAttribute('POSITION', acc('VEC3', new Float32Array(g.pos)))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array(g.nor)))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array(g.uv)))
      .setAttribute(
        'JOINTS_0',
        acc('VEC4', joints.length < 256 ? new Uint8Array(g.jnt) : new Uint16Array(g.jnt)),
      )
      .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array(g.wgt)))
      .setIndices(acc('SCALAR', vcount < 65536 ? new Uint16Array(g.idx) : new Uint32Array(g.idx)));
    mesh.addPrimitive(prim);
    trianglesAfter += g.idx.length / 3;
    // "After": the merged vertices skinned at rest, as three.js will draw them.
    for (let i = 0; i < vcount; i++) {
      const p = point(M, g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
      grow(boxAfter, skinAtRest(skinMats, p, g.jnt.slice(i * 4, i * 4 + 4), g.wgt.slice(i * 4, i * 4 + 4)));
    }
  }

  const oldMeshes = new Set(parts.map((n) => n.getMesh()));
  // Emptied part nodes must drop their skin too, so prune can remove them.
  for (const n of parts) n.setMesh(null).setSkin(null);
  for (const m of oldMeshes) {
    for (const p of m.listPrimitives()) p.dispose();
    m.dispose();
  }
  target.setMesh(mesh).setSkin(skin).setName(name);

  return {
    partsBefore: parts.length,
    drawCallsAfter: groups.size,
    trianglesBefore,
    trianglesAfter,
    boxBefore: round(boxBefore),
    boxAfter: round(boxAfter),
  };
}
