// .bin layout: uint32 JSON byte length, JSON (padded to 4 bytes), then 4-byte-aligned arrays.
// Every array is described in the JSON as { buffer: { offset, count, type } }, offsets from the file start.
// Plain ESM with no Node imports, so the page can use decodeAsset() as is.

const TYPES = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };

export function encodeAsset(header, arrays) {
  const json0 = JSON.stringify(header);
  // Offsets depend on the JSON length, which depends on the offsets: iterate until stable.
  let jsonLen = new TextEncoder().encode(json0).length + 64 * Object.keys(arrays).length;
  let bytes, layout;
  for (let pass = 0; pass < 4; pass++) {
    const start = 4 + ((jsonLen + 3) & ~3);
    let off = start;
    layout = {};
    for (const [key, arr] of Object.entries(arrays)) {
      const type = Object.keys(TYPES).find((t) => arr instanceof TYPES[t]);
      layout[key] = { offset: off, count: arr.length, type };
      off = (off + arr.byteLength + 3) & ~3;
    }
    const json = JSON.stringify({ ...header, buffers: layout });
    bytes = new TextEncoder().encode(json);
    if (bytes.length <= jsonLen) {
      const out = new Uint8Array(off);
      new DataView(out.buffer).setUint32(0, jsonLen, true);
      out.fill(0x20, 4, start);
      out.set(bytes, 4);
      for (const [key, arr] of Object.entries(arrays)) {
        out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), layout[key].offset);
      }
      return out;
    }
    jsonLen = bytes.length + 64;
  }
  throw new Error("encodeAsset: JSON length did not settle");
}

export function decodeAsset(buffer) {
  const len = new DataView(buffer).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, len)));
  const arrays = {};
  for (const [key, { offset, count, type }] of Object.entries(header.buffers)) {
    arrays[key] = new TYPES[type](buffer, offset, count);
  }
  return { header, arrays };
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  const h = sign | (e << 10) | (m >> 13);
  return h + ((m >> 12) & 1);
}

export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// Octahedral unit-vector encoding into two snorm16 values.
export function octEncode(x, y, z, out, i) {
  const l = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l, v = y / l;
  if (z < 0) {
    const pu = u;
    u = (1 - Math.abs(v)) * (pu >= 0 ? 1 : -1);
    v = (1 - Math.abs(pu)) * (v >= 0 ? 1 : -1);
  }
  out[i] = Math.round(Math.max(-1, Math.min(1, u)) * 32767);
  out[i + 1] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
}

export function octDecode(a, b, out = [0, 0, 0]) {
  let u = a / 32767, v = b / 32767;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const pu = u;
    u = (1 - Math.abs(v)) * (pu >= 0 ? 1 : -1);
    v = (1 - Math.abs(pu)) * (v >= 0 ? 1 : -1);
  }
  const l = Math.hypot(u, v, z);
  out[0] = u / l; out[1] = v / l; out[2] = z / l;
  return out;
}

// Positions are stored as uint16 across [qmin, qmin + qsize] per axis.
export function decodeLod(lod, arrays) {
  const q = arrays[lod.position], nq = arrays[lod.normal];
  const n = lod.verts;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) position[i * 3 + k] = lod.qmin[k] + (q[i * 3 + k] / 65535) * lod.qsize[k];
    octDecode(nq[i * 2], nq[i * 2 + 1], tmp);
    normal.set(tmp, i * 3);
  }
  const ao = new Float32Array(n);
  const a = arrays[lod.ao];
  for (let i = 0; i < n; i++) ao[i] = a[i] / 255;
  return { position, normal, ao, index: arrays[lod.index] };
}

export function decodeSdf(sdf, arrays) {
  const h = arrays[sdf.data];
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) out[i] = fromHalf(h[i]);
  return out;
}
