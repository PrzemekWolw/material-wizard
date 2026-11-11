import { fft2, nextPot } from './fft.js';

export function lumaOf(rgba, i) {
  return (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
}

export function seamScore(rgba, w, h, axis) {
  let sum = 0;
  let n = 0;
  if (axis === 'x') {
    for (let y = 0; y < h; y++) {
      const a = (y * w) * 4;
      const b = (y * w + w - 1) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(rgba[a + c] - rgba[b + c]);
      n += 3;
    }
  } else {
    for (let x = 0; x < w; x++) {
      const a = x * 4;
      const b = ((h - 1) * w + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(rgba[a + c] - rgba[b + c]);
      n += 3;
    }
  }
  return n ? sum / n / 255 : 0;
}

function resample(rgba, w, h, dw, dh) {
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * h / dh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * w / dw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const s = (xx, yy) => lumaOf(rgba, (yy * w + xx) * 4);
      const v = s(x0, y0) * (1 - fx) * (1 - fy) + s(x1, y0) * fx * (1 - fy) + s(x0, y1) * (1 - fx) * fy + s(x1, y1) * fx * fy;
      out[y * dw + x] = v;
    }
  }
  return out;
}

export function findRepeat(rgba, w, h) {
  const dw = Math.min(256, nextPot(Math.min(w, 256)));
  const dh = Math.min(256, nextPot(Math.min(h, 256)));
  const src = resample(rgba, w, h, dw, dh);
  const re = new Float64Array(dw * dh);
  const im = new Float64Array(dw * dh);
  let mean = 0;
  for (let i = 0; i < src.length; i++) mean += src[i];
  mean /= src.length;
  for (let i = 0; i < src.length; i++) re[i] = src[i] - mean;
  fft2(re, im, dw, dh, false);
  for (let i = 0; i < re.length; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft2(re, im, dw, dh, true);
  re[0] = 0;
  const peaks = [];
  const minX = Math.max(4, Math.floor(dw * 0.08));
  const minY = Math.max(4, Math.floor(dh * 0.08));
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      if (x < minX && y < minY) continue;
      if (x > dw - minX && y < minY) continue;
      if (x < minX && y > dh - minY) continue;
      const v = re[y * dw + x];
      let peak = true;
      for (let yy = -2; yy <= 2 && peak; yy++) {
        for (let xx = -2; xx <= 2; xx++) {
          if (!xx && !yy) continue;
          const px = (x + xx + dw) % dw;
          const py = (y + yy + dh) % dh;
          if (re[py * dw + px] > v) { peak = false; break; }
        }
      }
      if (peak) peaks.push({ x, y, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const best = peaks[0];
  if (!best || best.v <= 0) return null;
  let px = best.x;
  let py = best.y;
  if (px > dw / 2) px = dw - px;
  if (py > dh / 2) py = dh - py;
  const periodX = Math.max(8, Math.round(px * w / dw));
  const periodY = Math.max(8, Math.round(py * h / dh));
  const cropW = Math.max(periodX, Math.floor(w / periodX) * periodX);
  const cropH = Math.max(periodY, Math.floor(h / periodY) * periodY);
  return { periodX, periodY, cropW: Math.min(w, cropW), cropH: Math.min(h, cropH) };
}
