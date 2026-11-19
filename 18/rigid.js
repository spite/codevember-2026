// Column-major 4x4 rigid transforms (rotation and translation) as plain arrays, laid out like three's Matrix4, so the
// cutting worker needs no three.

function identity(out = new Float64Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

// Rotation about Z by a, then translated by (x, y, z).
function rotationZ(out, a, x = 0, y = 0, z = 0) {
  identity(out);
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = c; out[1] = s; out[4] = -s; out[5] = c;
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

function rotationX(out, a) {
  identity(out);
  const c = Math.cos(a), s = Math.sin(a);
  out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
  return out;
}

function rotationY(out, a) {
  identity(out);
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
  return out;
}

function translation(out, x, y, z) {
  identity(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

const _t = new Float64Array(16);
// out = a * b (out may alias either).
function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) _t[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  out.set(_t);
  return out;
}

// Inverse of a rotation + translation.
function invertRigid(out, m) {
  const r00 = m[0], r10 = m[1], r20 = m[2], r01 = m[4], r11 = m[5], r21 = m[6], r02 = m[8], r12 = m[9], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  identity(out);
  out[0] = r00; out[1] = r01; out[2] = r02;
  out[4] = r10; out[5] = r11; out[6] = r12;
  out[8] = r20; out[9] = r21; out[10] = r22;
  out[12] = -(r00 * tx + r10 * ty + r20 * tz);
  out[13] = -(r01 * tx + r11 * ty + r21 * tz);
  out[14] = -(r02 * tx + r12 * ty + r22 * tz);
  return out;
}

export { identity, rotationZ, rotationX, rotationY, translation, multiply, invertRigid };
