import {
  parseFbx, writeFbx, arrayValues, setArrayValues,
  child, childrenNamed, top, splitName, joinName, deepClone,
} from './fbx.js';

const PREFIX_RE = /^mixamorig\d*:/;

// Mixamo -> UE4/UE5 Mannequin bone names
const SIDES = { Left: 'l', Right: 'r' };
const FINGERS = { Thumb: 'thumb', Index: 'index', Middle: 'middle', Ring: 'ring', Pinky: 'pinky' };
const BODY = {
  Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03',
  Neck: 'neck_01', Head: 'head', HeadTop_End: 'head_end',
};
const LIMBS = {
  Shoulder: 'clavicle', Arm: 'upperarm', ForeArm: 'lowerarm', Hand: 'hand',
  UpLeg: 'thigh', Leg: 'calf', Foot: 'foot', ToeBase: 'ball', Toe_End: 'ball_end',
};

export function mannequinName(bare) {
  if (BODY[bare]) return BODY[bare];
  const m = /^(Left|Right)(.+)$/.exec(bare);
  if (!m) return bare;
  const side = SIDES[m[1]], rest = m[2];
  if (LIMBS[rest]) return `${LIMBS[rest]}_${side}`;
  const f = /^Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/.exec(rest);
  if (f) return `${FINGERS[f[1]]}_0${f[2]}_${side}`;
  return bare;
}

export const DEFAULT_OPTIONS = {
  naming: 'mannequin',    // 'mannequin' | 'strip' | 'keep'
  rootName: 'root',
  rootMotion: 'horizontal', // 'horizontal' | 'all' | 'none'
  rootVertical: false,      // also move vertical hips movement, root never goes below the ground
  startAtOrigin: true,      // shift the animation horizontally so the first frame stands at the origin
  rootRotation: false,      // move hips yaw (rotation around the up axis) to root
  removeEmptyTakes: true,
};

const prop70 = (node, name) => child(node, 'Properties70')?.children.find((p) => p.props[0].value === name);

/**
 * Converts a Mixamo binary FBX for Unreal Engine.
 * @returns {{bytes: Uint8Array, report: string[]}}
 */
export async function convertMixamo(input, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const report = [];
  const fbx = parseFbx(input);
  const objects = top(fbx, 'Objects');
  const connections = top(fbx, 'Connections');
  if (!objects || !connections) throw new Error('File has no Objects/Connections sections');

  const byId = new Map(objects.children.map((o) => [o.props[0].value, o]));
  const conns = () => connections.children.map((c) => ({
    node: c, kind: c.props[0].value, src: c.props[1].value, dst: c.props[2].value, prop: c.props[3]?.value,
  }));
  const isBone = (o) => o?.name === 'Model' && o.props[2].value === 'LimbNode';
  let nextId = [...byId.keys()].reduce((a, b) => (b > a ? b : a), 0n) + 1000n;
  const newId = () => nextId++;
  const addObject = (o) => { objects.children.push(o); byId.set(o.props[0].value, o); };
  const connect = (kind, src, dst, prop) => {
    const props = [{ type: 'S', value: kind }, { type: 'L', value: src }, { type: 'L', value: dst }];
    if (prop) props.push({ type: 'S', value: prop });
    connections.children.push({ name: 'C', props, children: [], sentinel: false });
  };

  // ---- find skeleton root (Hips) ----
  const bones = objects.children.filter(isBone);
  if (!bones.length) throw new Error('No skeleton (LimbNode) found in file');
  const parentOf = new Map();
  const isParentLink = (c) => c.kind === 'OO' && (c.dst === 0n || byId.get(c.dst)?.name === 'Model');
  for (const c of conns()) if (isBone(byId.get(c.src)) && isParentLink(c)) parentOf.set(c.src, c.dst);
  const roots = bones.filter((b) => !isBone(byId.get(parentOf.get(b.props[0].value))));
  if (roots.length !== 1) throw new Error(`Expected one root bone, found ${roots.length}`);
  const hips = roots[0];
  const hipsId = hips.props[0].value;
  const hipsName = splitName(hips.props[1].value).name;
  if (/^root$/i.test(hipsName.replace(PREFIX_RE, ''))) throw new Error('Root bone already exists, this file looks converted already');
  report.push(`Skeleton: ${bones.length} bones, root "${hipsName}"`);

  // ---- remove empty takes (Mixamo skin export carries an empty "Take 001") ----
  if (opt.removeEmptyTakes) {
    const stacks = objects.children.filter((o) => o.name === 'AnimationStack');
    const all = conns();
    for (const stack of stacks) {
      const sid = stack.props[0].value;
      const layers = all.filter((c) => c.dst === sid && byId.get(c.src)?.name === 'AnimationLayer').map((c) => c.src);
      const used = layers.some((l) => all.some((c) => c.dst === l));
      if (used || stacks.length === 1) continue;
      const dead = new Set([sid, ...layers]);
      objects.children = objects.children.filter((o) => !dead.has(o.props[0].value));
      connections.children = connections.children.filter((c) => !dead.has(c.props[1].value) && !dead.has(c.props[2].value));
      const takeName = splitName(stack.props[1].value).name;
      const takes = top(fbx, 'Takes');
      if (takes) takes.children = takes.children.filter((t) => !(t.name === 'Take' && t.props[0].value === takeName));
      bumpDefinition(fbx, 'AnimationStack', -1);
      bumpDefinition(fbx, 'AnimationLayer', -layers.length);
      report.push(`Removed empty duplicate take "${takeName}"`);
    }
  }

  // ---- rename bones ----
  if (opt.naming !== 'keep') {
    const renames = new Map();
    for (const b of bones) {
      const { name, cls } = splitName(b.props[1].value);
      const bare = name.replace(PREFIX_RE, '');
      const next = opt.naming === 'mannequin' ? mannequinName(bare) : bare;
      if (next !== name) { renames.set(name, next); b.props[1].value = joinName(next, cls); }
    }
    for (const o of objects.children) {
      if (o.name !== 'Deformer' && o.name !== 'NodeAttribute') continue;
      const { name, cls } = splitName(o.props[1].value);
      const m = /^(Cluster )?(.*)$/.exec(name);
      if (renames.has(m[2])) o.props[1].value = joinName((m[1] || '') + renames.get(m[2]), cls);
    }
    report.push(`Renamed ${renames.size} bones (${opt.naming === 'mannequin' ? 'UE Mannequin names' : 'stripped mixamorig: prefix'})`);
  }

  // ---- add root bone ----
  const rootId = newId();
  const rootAttrId = newId();
  addObject(makeRootModel(rootId, opt.rootName, hips, opt.rootRotation));
  const hipsAttr = conns().find((c) => c.dst === hipsId && byId.get(c.src)?.name === 'NodeAttribute');
  if (hipsAttr) {
    const attr = deepClone(byId.get(hipsAttr.src));
    attr.props[0].value = rootAttrId;
    attr.props[1].value = joinName(opt.rootName, 'NodeAttribute');
    addObject(attr);
    connect('OO', rootAttrId, rootId);
    bumpDefinition(fbx, 'NodeAttribute', 1);
  }
  bumpDefinition(fbx, 'Model', 1);
  // Re-parent: Hips -> root -> (Hips' old parent, usually scene root 0)
  const hipsParentConn = conns().find((c) => c.src === hipsId && isParentLink(c))?.node;
  const oldParent = hipsParentConn ? hipsParentConn.props[2].value : 0n;
  if (hipsParentConn) hipsParentConn.props[2].value = rootId;
  else connect('OO', hipsId, rootId);
  connect('OO', rootId, oldParent);
  // Put root into every bind pose that contains Hips (identity transform)
  for (const pose of objects.children.filter((o) => o.name === 'Pose')) {
    const nodes = childrenNamed(pose, 'PoseNode');
    if (!nodes.some((n) => child(n, 'Node')?.props[0].value === hipsId)) continue;
    pose.children.splice(pose.children.indexOf(nodes[0]), 0, makePoseNode(rootId));
    const nb = child(pose, 'NbPoseNodes');
    if (nb) nb.props[0].value += 1;
  }
  report.push(`Added "${opt.rootName}" bone above "${splitName(hips.props[1].value).name}"`);

  // ---- move root motion (translation and optionally yaw) from Hips to root ----
  if (opt.rootMotion !== 'none' || opt.rootRotation || opt.rootVertical || opt.startAtOrigin) {
    await moveRootMotion({ fbx, opt, report, hips, rootId, byId, conns, newId, addObject, connect });
  }

  return { bytes: writeFbx(fbx), report };
}

// ---------- root motion ----------

const AXES = ['X', 'Y', 'Z'];

async function moveRootMotion({ fbx, opt, report, hips, rootId, byId, conns, newId, addObject, connect }) {
  const hipsId = hips.props[0].value;
  const up = upAxisIndex(fbx);
  const yaw = !!opt.rootRotation;
  if (yaw && up !== 1) throw new Error('Root rotation is only supported for Y-up files');
  if (yaw && (prop70(hips, 'RotationOrder')?.props[4].value ?? 0) !== 0) {
    throw new Error('Root rotation needs hips rotation order XYZ');
  }
  const moved = opt.rootMotion === 'none' ? [] : AXES.map((_, i) => i).filter((i) => opt.rootMotion === 'all' || i !== up);
  const vertical = opt.rootVertical && !moved.includes(up);
  const vec = (name, def = [0, 0, 0]) => prop70(hips, name)?.props.slice(4).map((p) => p.value) ?? def;
  const rest = vec('Lcl Translation');
  const pre = eulerXYZ(vec('PreRotation'));
  const preInv = transpose(pre);
  const postInv = transpose(eulerXYZ(vec('PostRotation')));

  const all = conns();
  const layerOf = (id) => all.find((c) => c.kind === 'OO' && c.src === id && byId.get(c.dst)?.name === 'AnimationLayer')?.dst;
  const animNodes = (prop) => all.filter((c) => c.kind === 'OP' && c.dst === hipsId && c.prop === prop).map((c) => c.src);
  const rNodes = animNodes('Lcl Rotation');
  const tNodes = animNodes('Lcl Translation');
  if (!tNodes.length) {
    report.push('Hips have no translation animation, nothing to move to root');
    return;
  }

  // Heading reference: the hips axis that is the most horizontal in the rest pose.
  const restRot = mul(mul(pre, eulerXYZ(vec('Lcl Rotation'))), postInv);
  const refAxis = [2, 0, 1].reduce((best, i) => (Math.hypot(restRot[0][i], restRot[2][i]) > Math.hypot(restRot[0][best], restRot[2][best]) + 1e-6 ? i : best), 2);
  const heading = (m) => Math.atan2(m[0][refAxis], m[2][refAxis]);
  const heading0 = heading(restRot);

  for (const tId of tNodes) {
    const layer = layerOf(tId);
    const rId = yaw ? rNodes.find((id) => layerOf(id) === layer) : undefined;
    const T = await readChannels(tId);
    const R = rId ? await readChannels(rId) : null;
    if (yaw && !R) report.push('Hips have no rotation animation, root rotation skipped');
    const doYaw = yaw && !!R;
    const times = unionTimes([...T.curves, ...(R ? R.curves : [])]);
    const n = times.length;
    const tv = T.curves.map((c, i) => sampleCurve(c, times, T.defaults[i]));
    const rv = R ? R.curves.map((c, i) => sampleCurve(c, times, R.defaults[i])) : null;

    const rootT = AXES.map(() => new Float32Array(n));
    const hipsT = AXES.map(() => new Float32Array(n));
    const rootYaw = new Float32Array(n);
    const hipsR = AXES.map(() => new Float32Array(n));
    let prevYaw = 0, prevEuler = rv ? [rv[0][0], rv[1][0], rv[2][0]] : [0, 0, 0];
    // Constant horizontal shift that puts the first frame over the origin
    const shift = AXES.map((_, i) => (opt.startAtOrigin && i !== up ? tv[i][0] - rest[i] : 0));
    for (let k = 0; k < n; k++) {
      const h = [tv[0][k] - shift[0], tv[1][k] - shift[1], tv[2][k] - shift[2]];
      const r = AXES.map((_, i) => (moved.includes(i) ? h[i] - rest[i] : 0));
      if (vertical) r[up] = Math.max(0, h[up] - rest[up]); // lifts on jumps, stays on the ground otherwise
      let psi = 0;
      let rot = null;
      if (doYaw) {
        rot = eulerXYZ([rv[0][k], rv[1][k], rv[2][k]]);
        psi = heading(mul(mul(pre, rot), postInv)) - heading0;
        psi += 2 * Math.PI * Math.round((prevYaw - psi) / (2 * Math.PI)); // keep continuous
        prevYaw = psi;
      }
      const unYaw = rotY(-psi);
      const local = apply(unYaw, [h[0] - r[0], h[1] - r[1], h[2] - r[2]]);
      for (let i = 0; i < 3; i++) { rootT[i][k] = r[i]; hipsT[i][k] = local[i]; }
      if (doYaw) {
        const e = matToEulerXYZ(mul(mul(mul(preInv, unYaw), pre), rot), prevEuler);
        for (let i = 0; i < 3; i++) hipsR[i][k] = e[i];
        prevEuler = e;
        rootYaw[k] = (psi * 180) / Math.PI;
      }
    }

    // Write hips curves back
    const template = [...T.curves, ...(R ? R.curves : [])].find(Boolean);
    const ensureCurve = (channels, nodeId, i) => {
      if (channels.curves[i]) return channels.curves[i];
      const c = newCurve(template);
      connect('OP', c.props[0].value, nodeId, `d|${AXES[i]}`);
      return (channels.curves[i] = c);
    };
    const newCurve = (tpl) => {
      const c = deepClone(tpl);
      c.props[0].value = newId();
      addObject(c);
      bumpDefinition(fbx, 'AnimationCurve', 1);
      return c;
    };
    for (let i = 0; i < 3; i++) await writeCurve(ensureCurve(T, tId, i), times, hipsT[i]);
    if (doYaw) for (let i = 0; i < 3; i++) await writeCurve(ensureCurve(R, rId, i), times, hipsR[i]);

    // Root curve nodes, in the same animation layer as the hips ones
    const makeNode = async (srcNodeId, prop, valuesPerAxis) => {
      const node = deepClone(byId.get(srcNodeId));
      const id = newId();
      node.props[0].value = id;
      for (const p of child(node, 'Properties70').children) {
        if (/^d\|[XYZ]$/.test(p.props[0].value)) p.props[4].value = 0;
      }
      node.children = node.children.filter((c) => c.name === 'Properties70');
      addObject(node);
      bumpDefinition(fbx, 'AnimationCurveNode', 1);
      connect('OP', id, rootId, prop);
      if (layer !== undefined) connect('OO', id, layer);
      for (let i = 0; i < 3; i++) {
        const c = newCurve(template);
        await writeCurve(c, times, valuesPerAxis[i]);
        connect('OP', c.props[0].value, id, `d|${AXES[i]}`);
      }
    };
    await makeNode(tId, 'Lcl Translation', rootT);
    if (doYaw) await makeNode(rId, 'Lcl Rotation', [new Float32Array(n), rootYaw, new Float32Array(n)]);

    const parts = [];
    if (moved.length) parts.push(`translation ${moved.map((i) => AXES[i]).join('')}`);
    if (shift.some((v) => Math.abs(v) > 1e-4)) {
      report.push(`Moved the start to the origin (shifted by ${shift.filter((_, i) => i !== up).map((v) => v.toFixed(1)).join(', ')} cm)`);
    }
    if (vertical) parts.push(`vertical ${AXES[up]} (on ground)`);
    if (doYaw) parts.push('yaw rotation');
    if (parts.length) report.push(`Root motion (${parts.join(' + ')}) moved from hips to ${opt.rootName}`);
  }

  async function readChannels(nodeId) {
    const node = byId.get(nodeId);
    const defaults = AXES.map((a) => prop70(node, `d|${a}`)?.props[4].value ?? 0);
    const curves = AXES.map((a) => {
      const c = all.find((x) => x.kind === 'OP' && x.dst === nodeId && x.prop === `d|${a}`);
      return c ? byId.get(c.src) : null;
    });
    for (const c of curves) {
      if (!c) continue;
      c.times = await arrayValues(child(c, 'KeyTime').props[0]);
      c.values = await arrayValues(child(c, 'KeyValueFloat').props[0]);
    }
    return { defaults, curves };
  }
}

function unionTimes(curves) {
  const present = curves.filter(Boolean);
  const first = present[0].times;
  if (present.every((c) => c.times.length === first.length && c.times.every((t, i) => t === first[i]))) return first;
  const set = new Set();
  for (const c of present) for (const t of c.times) set.add(t);
  return BigInt64Array.from([...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sampleCurve(curve, times, def) {
  if (!curve) return new Float64Array(times.length).fill(def);
  if (curve.times === times) return curve.values;
  const out = new Float64Array(times.length);
  const kt = curve.times, kv = curve.values;
  let j = 0;
  for (let k = 0; k < times.length; k++) {
    const t = times[k];
    while (j < kt.length - 1 && kt[j + 1] <= t) j++;
    if (t <= kt[0]) out[k] = kv[0];
    else if (j >= kt.length - 1) out[k] = kv[kt.length - 1];
    else out[k] = kv[j] + (kv[j + 1] - kv[j]) * Number(t - kt[j]) / Number(kt[j + 1] - kt[j]);
  }
  return out;
}

async function writeCurve(curve, times, values) {
  const keyTime = child(curve, 'KeyTime').props[0];
  const keyValue = child(curve, 'KeyValueFloat').props[0];
  if (keyTime.value.length !== times.length || keyTime.value.values !== times) setArrayValues(keyTime, times.slice());
  setArrayValues(keyValue, Float32Array.from(values));
  setDefault(curve, values[0]);
  // All keys share the first key attribute (Mixamo uses a single one anyway)
  const flags = child(curve, 'KeyAttrFlags')?.props[0];
  const data = child(curve, 'KeyAttrDataFloat')?.props[0];
  const refs = child(curve, 'KeyAttrRefCount')?.props[0];
  if (!flags || !data || !refs) return;
  const r = await arrayValues(refs);
  if (r.length === 1 && r[0] === times.length) return;
  setArrayValues(flags, (await arrayValues(flags)).slice(0, 1));
  setArrayValues(data, (await arrayValues(data)).slice(0, 4));
  setArrayValues(refs, Int32Array.from([times.length]));
}

// ---------- 3x3 rotation math (FBX Euler XYZ: M = Rz * Ry * Rx, degrees) ----------

const DEG = Math.PI / 180;

function eulerXYZ([x, y, z]) {
  const cx = Math.cos(x * DEG), sx = Math.sin(x * DEG);
  const cy = Math.cos(y * DEG), sy = Math.sin(y * DEG);
  const cz = Math.cos(z * DEG), sz = Math.sin(z * DEG);
  return [
    [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
    [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
    [-sy, sx * cy, cx * cy],
  ];
}

function matToEulerXYZ(m, prev) {
  const sy = Math.max(-1, Math.min(1, -m[2][0]));
  const y = Math.asin(sy);
  let x, z;
  if (Math.abs(sy) < 0.999999) {
    x = Math.atan2(m[2][1], m[2][2]);
    z = Math.atan2(m[1][0], m[0][0]);
  } else {
    x = Math.atan2(-m[1][2], m[1][1]);
    z = 0;
  }
  const a = [x / DEG, y / DEG, z / DEG];
  const b = [a[0] + 180, 180 - a[1], a[2] + 180];
  const near = (e) => e.map((v, i) => v + 360 * Math.round((prev[i] - v) / 360));
  const dist = (e) => e.reduce((s, v, i) => s + Math.abs(v - prev[i]), 0);
  const na = near(a), nb = near(b);
  return dist(na) <= dist(nb) ? na : nb;
}

const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const transpose = (m) => m[0].map((_, i) => m.map((r) => r[i]));
const mul = (a, b) => a.map((r) => b[0].map((_, j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const apply = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

// ---------- builders ----------

function P(name, type, label, flags, ...values) {
  const props = [name, type, label, flags].map((v) => ({ type: 'S', value: v }));
  for (const v of values) props.push(typeof v === 'number' && Number.isInteger(v) && (type === 'int' || type === 'bool' || type === 'enum') ? { type: 'I', value: v } : { type: 'D', value: v });
  return { name: 'P', props, children: [], sentinel: false };
}

function makeRootModel(id, name, hips, rotates) {
  const shading = child(hips, 'Shading');
  return {
    name: 'Model',
    props: [{ type: 'L', value: id }, { type: 'S', value: joinName(name, 'Model') }, { type: 'S', value: 'LimbNode' }],
    sentinel: true,
    children: [
      { name: 'Version', props: [{ type: 'I', value: 232 }], children: [], sentinel: false },
      {
        name: 'Properties70', props: [], sentinel: true, children: [
          P('RotationActive', 'bool', '', '', 1),
          P('DefaultAttributeIndex', 'int', 'Integer', '', 0),
          P('Lcl Translation', 'Lcl Translation', '', 'A+', 0, 0, 0),
          ...(rotates ? [P('Lcl Rotation', 'Lcl Rotation', '', 'A+', 0, 0, 0)] : []),
        ],
      },
      shading ? deepClone(shading) : { name: 'Shading', props: [{ type: 'C', value: 89 }], children: [], sentinel: false },
      { name: 'Culling', props: [{ type: 'S', value: 'CullingOff' }], children: [], sentinel: false },
    ],
  };
}

function makePoseNode(id) {
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return {
    name: 'PoseNode', props: [], sentinel: true, children: [
      { name: 'Node', props: [{ type: 'L', value: id }], children: [], sentinel: false },
      { name: 'Matrix', props: [{ type: 'd', value: { values: identity } }], children: [], sentinel: false },
    ],
  };
}

function setDefault(curve, v) {
  const d = child(curve, 'Default');
  if (d) d.props[0].value = v;
}

function upAxisIndex(fbx) {
  const gs = top(fbx, 'GlobalSettings');
  const p = gs && prop70(gs, 'UpAxis');
  return p ? p.props[4].value : 1;
}

function bumpDefinition(fbx, type, delta) {
  const defs = top(fbx, 'Definitions');
  if (!defs || !delta) return;
  const total = child(defs, 'Count');
  if (total) total.props[0].value += delta;
  const ot = childrenNamed(defs, 'ObjectType').find((o) => o.props[0].value === type);
  const cnt = ot && child(ot, 'Count');
  if (cnt) cnt.props[0].value += delta;
}
