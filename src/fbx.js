// Minimal binary FBX reader/writer.
// Arrays are kept as raw (possibly compressed) bytes until someone asks for
// their values, so an unmodified file round-trips byte-for-byte.

const MAGIC = 'Kaydara FBX Binary  \x00\x1a\x00';
const textDecoder = new TextDecoder('latin1');

/**
 * @typedef {{name: string, props: Prop[], children: FbxNode[], sentinel: boolean}} FbxNode
 * @typedef {{type: string, value: any}} Prop
 * Array props: value = {encoding, raw: Uint8Array, length} or {values: TypedArray}
 */

export function parseFbx(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = textDecoder.decode(bytes.subarray(0, 23));
  if (magic !== MAGIC) {
    throw new Error('Not a binary FBX (ASCII FBX is not supported)');
  }
  const version = view.getUint32(23, true);
  const wide = version >= 7500;
  let pos = 27;

  const u32 = () => { const v = view.getUint32(pos, true); pos += 4; return v; };
  const off = () => {
    if (!wide) return u32();
    const v = Number(view.getBigUint64(pos, true)); pos += 8; return v;
  };

  function readProp() {
    const type = String.fromCharCode(bytes[pos++]);
    let value;
    switch (type) {
      case 'Y': value = view.getInt16(pos, true); pos += 2; break;
      case 'C': value = bytes[pos]; pos += 1; break; // raw byte (often 'Y'/'T')
      case 'I': value = view.getInt32(pos, true); pos += 4; break;
      case 'F': value = view.getFloat32(pos, true); pos += 4; break;
      case 'D': value = view.getFloat64(pos, true); pos += 8; break;
      case 'L': value = view.getBigInt64(pos, true); pos += 8; break;
      case 'S': case 'R': {
        const len = u32();
        const raw = bytes.slice(pos, pos + len); pos += len;
        value = type === 'S' ? textDecoder.decode(raw) : raw;
        break;
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const length = u32(), encoding = u32(), byteLen = u32();
        value = { length, encoding, raw: bytes.slice(pos, pos + byteLen) };
        pos += byteLen;
        break;
      }
      default:
        throw new Error(`Unknown property type '${type}' @${pos - 1}`);
    }
    return { type, value };
  }

  function readNode() {
    const end = off();
    const numProps = off();
    off(); // property list byte length
    const nameLen = bytes[pos++];
    if (end === 0) return null; // null record
    const name = textDecoder.decode(bytes.subarray(pos, pos + nameLen));
    pos += nameLen;
    const props = [];
    for (let i = 0; i < numProps; i++) props.push(readProp());
    const children = [];
    let sentinel = false;
    if (pos < end) {
      sentinel = true;
      while (pos < end) {
        const child = readNode();
        if (!child) break;
        children.push(child);
      }
    }
    pos = end;
    return { name, props, children, sentinel };
  }

  const nodes = [];
  while (pos < bytes.length) {
    const node = readNode();
    if (!node) break;
    nodes.push(node);
  }
  // Footer: keep the 16-byte footer id that follows the top-level null record.
  const footerId = bytes.slice(pos, pos + 16);
  return { version, nodes, footerId };
}

// ---------- array helpers ----------

const ARRAY_CTOR = { f: Float32Array, d: Float64Array, l: BigInt64Array, i: Int32Array, b: Uint8Array };

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns a typed array with the values of an array property (decoding once). */
export async function arrayValues(prop) {
  const v = prop.value;
  if (v.values) return v.values;
  const data = v.encoding === 1 ? await inflate(v.raw) : v.raw;
  const Ctor = ARRAY_CTOR[prop.type];
  const copy = new Uint8Array(data); // ensure alignment
  v.values = new Ctor(copy.buffer, 0, v.length);
  return v.values;
}

/** Replaces an array property's values (written uncompressed). */
export function setArrayValues(prop, values) {
  prop.value = { values };
}

// ---------- writer ----------

const textEncoder = new TextEncoder();
function latin1(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 20); this.view = new DataView(this.buf.buffer); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size); next.set(this.buf.subarray(0, this.pos));
    this.buf = next; this.view = new DataView(next.buffer);
  }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v; }
  u32(v) { this.ensure(4); this.view.setUint32(this.pos, v, true); this.pos += 4; }
  u64(v) { this.ensure(8); this.view.setBigUint64(this.pos, BigInt(v), true); this.pos += 8; }
  i16(v) { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  i32(v) { this.ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
  f32(v) { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }
  f64(v) { this.ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
  i64(v) { this.ensure(8); this.view.setBigInt64(this.pos, BigInt(v), true); this.pos += 8; }
  result() { return this.buf.slice(0, this.pos); }
}

export function writeFbx(fbx) {
  const w = new Writer();
  const wide = fbx.version >= 7500;
  const offSize = wide ? 8 : 4;
  const putOff = (v) => (wide ? w.u64(v) : w.u32(v));
  const setOffAt = (at, v) => (wide ? w.view.setBigUint64(at, BigInt(v), true) : w.view.setUint32(at, v, true));
  const nullRecord = new Uint8Array(offSize * 3 + 1);

  w.bytes(latin1(MAGIC));
  w.u32(fbx.version);

  function writeProp({ type, value }) {
    w.u8(type.charCodeAt(0));
    switch (type) {
      case 'Y': w.i16(value); break;
      case 'C': w.u8(typeof value === 'number' ? value : value ? 1 : 0); break;
      case 'I': w.i32(value); break;
      case 'F': w.f32(value); break;
      case 'D': w.f64(value); break;
      case 'L': w.i64(value); break;
      case 'S': { const b = latin1(value); w.u32(b.length); w.bytes(b); break; }
      case 'R': w.u32(value.length); w.bytes(value); break;
      default: {
        if (value.values) {
          const b = new Uint8Array(value.values.buffer, value.values.byteOffset, value.values.byteLength);
          w.u32(value.values.length); w.u32(0); w.u32(b.length); w.bytes(b);
        } else {
          w.u32(value.length); w.u32(value.encoding); w.u32(value.raw.length); w.bytes(value.raw);
        }
      }
    }
  }

  function writeNode(node) {
    const start = w.pos;
    putOff(0); putOff(node.props.length); putOff(0);
    const nameBytes = latin1(node.name);
    w.u8(nameBytes.length); w.bytes(nameBytes);
    const propsStart = w.pos;
    for (const p of node.props) writeProp(p);
    setOffAt(start + offSize * 2, w.pos - propsStart);
    if (node.children.length || node.sentinel || node.props.length === 0) {
      for (const c of node.children) writeNode(c);
      w.bytes(nullRecord);
    }
    setOffAt(start, w.pos);
  }

  for (const n of fbx.nodes) writeNode(n);
  w.bytes(nullRecord);

  // Footer (same layout the FBX SDK / Blender produce)
  w.bytes(fbx.footerId);
  let pad = ((w.pos + 15) & ~15) - w.pos;
  if (pad === 0) pad = 16;
  w.bytes(new Uint8Array(pad + 4));
  w.u32(fbx.version);
  w.bytes(new Uint8Array(120));
  w.bytes(new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]));
  return w.result();
}

// ---------- tree helpers ----------

export const child = (node, name) => node.children.find((c) => c.name === name);
export const childrenNamed = (node, name) => node.children.filter((c) => c.name === name);
export const top = (fbx, name) => fbx.nodes.find((n) => n.name === name);

/** "mixamorig:Hips\x00\x01Model" -> {name: "mixamorig:Hips", cls: "Model"} */
export function splitName(s) {
  const i = s.indexOf('\x00\x01');
  return i < 0 ? { name: s, cls: '' } : { name: s.slice(0, i), cls: s.slice(i + 2) };
}
export const joinName = (name, cls) => `${name}\x00\x01${cls}`;

export function deepClone(node) {
  return {
    name: node.name,
    sentinel: node.sentinel,
    props: node.props.map((p) => ({
      type: p.type,
      value: p.value && typeof p.value === 'object' && !(p.value instanceof Uint8Array)
        ? (p.value.values ? { values: p.value.values.slice() } : { ...p.value, raw: p.value.raw.slice() })
        : p.value instanceof Uint8Array ? p.value.slice() : p.value,
    })),
    children: node.children.map(deepClone),
  };
}
