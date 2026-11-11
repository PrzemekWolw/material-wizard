// Per-map levels, contrast and curve, baked into a 256-entry lookup table.

export const FLAT_CURVE = [0, 0.25, 0.5, 0.75, 1];

export const ADJUST_FIELDS = [
  ['inBlack', 0, 1, 0],
  ['inWhite', 0, 1, 1],
  ['gamma', 0.2, 5, 1],
  ['contrast', 0, 3, 1],
  ['outMin', 0, 1, 0],
  ['outMax', 0, 1, 1],
];

export function parseCurve(value) {
  const points = String(value || '').split(',').map(Number);
  return points.length === 5 && points.every(Number.isFinite) ? points : FLAT_CURVE.slice();
}

// Catmull-Rom through five points at x = 0, 0.25, 0.5, 0.75, 1, clamped to 0..1.
export function curveValue(points, t) {
  const x = Math.min(Math.max(t, 0), 1) * 4;
  const i = Math.min(3, Math.floor(x));
  const f = x - i;
  const p = (k) => points[Math.min(4, Math.max(0, k))];
  const p0 = i === 0 ? 2 * p(0) - p(1) : p(i - 1);
  const p3 = i === 3 ? 2 * p(4) - p(3) : p(i + 2);
  const p1 = p(i);
  const p2 = p(i + 1);
  const v = 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (3 * p1 - p0 - 3 * p2 + p3) * f * f * f);
  return Math.min(Math.max(v, 0), 1);
}

export function adjustValue(a, x) {
  let t = Math.min(Math.max((x - a.inBlack) / Math.max(1e-4, a.inWhite - a.inBlack), 0), 1);
  t = Math.pow(t, 1 / a.gamma);
  t = Math.min(Math.max((t - 0.5) * a.contrast + 0.5, 0), 1);
  t = curveValue(a.curve, t);
  return a.outMin + t * (a.outMax - a.outMin);
}

export function isIdentity(a) {
  return ADJUST_FIELDS.every(([key, , , def]) => a[key] === def) && a.curve.every((v, i) => v === FLAT_CURVE[i]);
}

// The table for an adjust object, or null when it changes nothing.
export function lutOf(a) {
  if (!a || isIdentity(a)) return null;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(adjustValue(a, i / 255) * 255);
  return lut;
}
