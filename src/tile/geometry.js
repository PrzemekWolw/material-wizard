import { lumaOf } from './seam.js';

export function rotateBuffer(rgba, w, h, turns) {
  let cur = rgba;
  let cw = w;
  let ch = h;
  const n = ((turns % 4) + 4) % 4;
  for (let t = 0; t < n; t++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = (y * cw + x) * 4;
        const nx = ch - 1 - y;
        const ny = x;
        next.set(cur.subarray(s, s + 4), (ny * ch + nx) * 4);
      }
    }
    cur = next;
    const tmp = cw;
    cw = ch;
    ch = tmp;
  }
  return { rgba: cur, w: cw, h: ch };
}

export function dominantAngle(rgba, w, h) {
  const bins = new Float64Array(36);
  const step = Math.max(1, Math.floor(Math.min(w, h) / 128));
  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const l = (xx, yy) => lumaOf(rgba, (yy * w + xx) * 4);
      const gx = l(x + step, y) - l(x - step, y);
      const gy = l(x, y + step) - l(x, y - step);
      const mag = Math.hypot(gx, gy);
      if (mag < 0.04) continue;
      let ang = Math.atan2(gy, gx) * 180 / Math.PI;
      ang = ((ang % 180) + 180) % 180;
      bins[Math.min(35, Math.floor(ang / 5))] += mag;
    }
  }
  let best = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
  const l = bins[(best + 35) % 36];
  const r = bins[(best + 1) % 36];
  const den = l - 2 * bins[best] + r;
  const offset = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den)) : 0;
  return (best + 0.5 + offset) * 5;
}

export function homographyFromQuad(quad) {
  const src = [0, 0, 1, 0, 1, 1, 0, 1];
  const dst = quad;
  const a = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i * 2];
    const y = src[i * 2 + 1];
    const u = dst[i * 2];
    const v = dst[i * 2 + 1];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    const tmp = a[col]; a[col] = a[piv]; a[piv] = tmp;
    const div = a[col][col] || 1e-8;
    for (let c = col; c < 9; c++) a[col][c] /= div;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row) => row[8]).concat([1]);
}

export function warpBuffer(rgba, w, h, matrix) {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / Math.max(1, w - 1);
      const v = y / Math.max(1, h - 1);
      const den = matrix[6] * u + matrix[7] * v + matrix[8];
      const sx = ((matrix[0] * u + matrix[1] * v + matrix[2]) / den) * (w - 1);
      const sy = ((matrix[3] * u + matrix[4] * v + matrix[5]) / den) * (h - 1);
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
      const d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = rgba[(y0 * w + x0) * 4 + c];
        const p10 = rgba[(y0 * w + x1) * 4 + c];
        const p01 = rgba[(y1 * w + x0) * 4 + c];
        const p11 = rgba[(y1 * w + x1) * 4 + c];
        out[d + c] = Math.round(p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy);
      }
    }
  }
  return out;
}
