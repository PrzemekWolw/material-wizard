import { srgbToLinear } from '../utils/color.js';

function minPath(cost, width, height) {
  const acc = new Float32Array(width * height);
  const prev = new Int32Array(width * height);
  for (let x = 0; x < width; x++) acc[x] = cost[x];
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = acc[(y - 1) * width + x];
      let from = x;
      if (x > 0 && acc[(y - 1) * width + x - 1] < best) { best = acc[(y - 1) * width + x - 1]; from = x - 1; }
      if (x + 1 < width && acc[(y - 1) * width + x + 1] < best) { best = acc[(y - 1) * width + x + 1]; from = x + 1; }
      acc[y * width + x] = cost[y * width + x] + best;
      prev[y * width + x] = from;
    }
  }
  let x = 0;
  const last = (height - 1) * width;
  for (let i = 1; i < width; i++) if (acc[last + i] < acc[last + x]) x = i;
  const path = new Int32Array(height);
  for (let y = height - 1; y >= 0; y--) {
    path[y] = x;
    if (y > 0) x = prev[y * width + x];
  }
  return path;
}

function smooth01(e0, e1, x) {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// 3x3 box blur, edges average only the taps inside.
function blur3(values, w, h) {
  const tmp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (x > 0 && x < w - 1) tmp[i] = (values[i - 1] + values[i] + values[i + 1]) / 3;
      else if (w === 1) tmp[i] = values[i];
      else tmp[i] = x === 0 ? (values[i] + values[i + 1]) / 2 : (values[i - 1] + values[i]) / 2;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : -1;
    const down = y < h - 1 ? row + w : -1;
    for (let x = 0; x < w; x++) {
      if (up >= 0 && down >= 0) out[row + x] = (tmp[up + x] + tmp[row + x] + tmp[down + x]) / 3;
      else if (up >= 0) out[row + x] = (tmp[up + x] + tmp[row + x]) / 2;
      else if (down >= 0) out[row + x] = (tmp[row + x] + tmp[down + x]) / 2;
      else out[row + x] = tmp[row + x];
    }
  }
  return out;
}

// Frame is normalized {x, y, w, h}. A side covers its edge with photo from beyond the opposite edge,
// so `left` needs margin right of the frame, `up` needs margin below it.
export function autoFrame(W, H, ratio, sides) {
  const need = (side) => (sides[side].on ? sides[side].b : 0);
  const mx = need('left') + need('right');
  const my = need('up') + need('down');
  let cw = W / (1 + mx);
  let ch = H / (1 + my);
  if (ratio) {
    ch = Math.min(ch, cw * ratio.b / ratio.a);
    cw = ch * ratio.a / ratio.b;
  }
  const x = need('right') * cw + (W - cw * (1 + mx)) / 2;
  const y = need('down') * ch + (H - ch * (1 + my)) / 2;
  return { x: x / W, y: y / H, w: cw / W, h: ch / H };
}

// Band pixel (t across, s along) is at d0 + t * dt + s * ds; its source is off pixels away.
function blendSide(bufs, along, size, avail, side, maxW, opts, d0, dt, ds, off) {
  let band = Math.round(side.b * size);
  let start = Math.round(side.a * size);
  const clipped = band > avail;
  if (clipped) band = avail;
  start = Math.min(start, band);
  if (band < 1) return clipped;
  const mask = new Float32Array(along * band);
  const width = band - start;
  const fade = new Float32Array(band);
  for (let t = 0; t < band; t++) fade[t] = t < start ? 1 : 1 - smooth01(start, band, t + 0.5);
  if (opts.cut && width >= 3) {
    const g = bufs[0];
    const cost = new Float32Array(along * width);
    for (let s = 0; s < along; s++) {
      for (let k = 0; k < width; k++) {
        const d = (d0 + (start + k) * dt + s * ds) * 4;
        const o = d + off * 4;
        const r = g[d] - g[o];
        const gr = g[d + 1] - g[o + 1];
        const b = g[d + 2] - g[o + 2];
        cost[s * width + k] = r * r + gr * gr + b * b;
      }
    }
    const path = minPath(blur3(cost, width, along), width, along);
    const feather = Math.max(0.5, opts.soft * width / 2);
    const ramp = opts.wrapAlong ? Math.max(2, Math.round(along * 0.08)) : 0;
    for (let s = 0; s < along; s++) {
      const at = start + path[s];
      const lo = Math.max(start, at - feather);
      const hi = Math.min(band, at + feather);
      const k = ramp ? Math.min(1, Math.min(s, along - 1 - s) / ramp) : 1;
      for (let t = 0; t < band; t++) {
        const cutM = t < start ? 1 : 1 - smooth01(lo, hi, t + 0.5);
        mask[s * band + t] = fade[t] + (cutM - fade[t]) * k;
      }
    }
  } else {
    for (let s = 0; s < along; s++) mask.set(fade, s * band);
  }
  for (const buf of bufs) {
    const weighted = mask.map((value) => value * maxW);
    blendBand(buf, along, band, weighted, (s, t) => d0 + t * dt + s * ds, off);
  }
  return clipped;
}

function boxMean(src, along, band, radius) {
  const tmp = new Float32Array(along * band);
  const out = new Float32Array(along * band);
  for (let s = 0; s < along; s++) {
    for (let t = 0; t < band; t++) {
      let sum = 0;
      let n = 0;
      const from = Math.max(0, t - radius);
      const to = Math.min(band - 1, t + radius);
      for (let k = from; k <= to; k++) { sum += src[s * band + k]; n++; }
      tmp[s * band + t] = sum / n;
    }
  }
  for (let t = 0; t < band; t++) {
    for (let s = 0; s < along; s++) {
      let sum = 0;
      let n = 0;
      const from = Math.max(0, s - radius);
      const to = Math.min(along - 1, s + radius);
      for (let k = from; k <= to; k++) { sum += tmp[k * band + t]; n++; }
      out[s * band + t] = sum / n;
    }
  }
  return out;
}

// The mean blends linearly. The detail is scaled back up so averaging two textures does not wash the band out.
function blendBand(buf, along, band, mask, indexAt, off) {
  const radius = 4;
  const o4 = off * 4;
  for (let channel = 0; channel < 4; channel++) {
    const dest = new Float32Array(along * band);
    const src = new Float32Array(along * band);
    for (let s = 0; s < along; s++) {
      for (let t = 0; t < band; t++) {
        const d = indexAt(s, t) * 4 + channel;
        dest[s * band + t] = buf[d];
        src[s * band + t] = buf[d + o4];
      }
    }
    const meanD = boxMean(dest, along, band, radius);
    const meanS = boxMean(src, along, band, radius);
    for (let s = 0; s < along; s++) {
      for (let t = 0; t < band; t++) {
        const m = mask[s * band + t];
        if (m <= 0) continue;
        const i = s * band + t;
        const mean = meanD[i] * (1 - m) + meanS[i] * m;
        const scale = Math.sqrt((1 - m) * (1 - m) + m * m) || 1;
        const detail = ((dest[i] - meanD[i]) * (1 - m) + (src[i] - meanS[i]) * m) / scale;
        const d = indexAt(s, t) * 4 + channel;
        buf[d] = Math.max(0, Math.min(255, mean + detail));
      }
    }
  }
}

function reflectIndex(i, n) {
  const m = n * 2;
  let k = i % m;
  if (k < 0) k += m;
  return k < n ? k : m - 1 - k;
}

function boxBlurReflect(src, n, radius) {
  const tmp = new Float64Array(n * n);
  const out = new Float64Array(n * n);
  const span = radius * 2 + 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[y * n + reflectIndex(x + k, n)];
      tmp[y * n + x] = sum / span;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[reflectIndex(y + k, n) * n + x];
      out[y * n + x] = sum / span;
    }
  }
  return out;
}

function chromaOf(r, g, b) {
  const sum = Math.max(r + g + b, 0.0001);
  return [r / sum, g / sum, b / sum];
}

// Divides out the broad lighting and the broad contrast, so a tile does not repeat a ramp, a vignette
// or a side that is harsher than the other. Both fields are a wide blur of cell statistics, so single
// stones cannot bend them. With picked colors (linear rgb), only cells of a similar chroma are measured.
function evenBuffer(buf, sw, picks, range, strength) {
  const h = buf.length / (sw * 4);
  const n = Math.max(8, Math.min(32, sw, h));
  const grid = new Float64Array(n * n);
  const spreadGrid = new Float64Array(n * n);
  const weights = new Float64Array(n * n).fill(1);
  const chromas = (picks || []).map((p) => chromaOf(p[0], p[1], p[2]));
  for (let row = 0; row < n; row++) {
    const y0 = Math.floor(row * h / n);
    const y1 = Math.max(y0 + 1, Math.floor((row + 1) * h / n));
    for (let col = 0; col < n; col++) {
      const x0 = Math.floor(col * sw / n);
      const x1 = Math.max(x0 + 1, Math.floor((col + 1) * sw / n));
      let sum = 0;
      let sumLog = 0;
      let sumLog2 = 0;
      let count = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          const luma = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
          const logL = Math.log(Math.max(luma / 255, 0.002));
          sum += luma;
          sumLog += logL;
          sumLog2 += logL * logL;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
          count++;
        }
      }
      const logMean = sumLog / count;
      grid[row * n + col] = Math.log(Math.max(sum / count / 255, 0.002));
      spreadGrid[row * n + col] = Math.sqrt(Math.max(0, sumLog2 / count - logMean * logMean));
      if (chromas.length) {
        const c = chromaOf(srgbToLinear(r / count / 255), srgbToLinear(g / count / 255), srgbToLinear(b / count / 255));
        const d = Math.min(...chromas.map((p) => Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2])));
        const t = Math.min(1, Math.max(0, (d - range) / range));
        weights[row * n + col] = 1 - t * t * (3 - 2 * t);
      }
    }
  }
  const radius = Math.max(1, Math.round(n / 10));
  const smooth = (src) => boxBlurReflect(boxBlurReflect(src, n, radius), n, radius);
  const blend = (src) => {
    const all = smooth(src);
    if (!chromas.length) return all;
    const top = smooth(src.map((v, i) => v * weights[i]));
    const bottom = smooth(weights);
    return all.map((v, i) => (top[i] + 0.02 * v) / (bottom[i] + 0.02));
  };
  const field = blend(grid);
  const spread = blend(spreadGrid);
  let mean = 0;
  let target = 0;
  for (let i = 0; i < field.length; i++) { mean += field[i]; target += spread[i]; }
  mean /= field.length;
  target /= spread.length;
  const at = (src, x, y) => {
    const gy = Math.min(n - 1.0001, Math.max(0, (y + 0.5) / h * n - 0.5));
    const gy0 = Math.floor(gy);
    const ty = gy - gy0;
    const gy1 = Math.min(n - 1, gy0 + 1);
    const gx = Math.min(n - 1.0001, Math.max(0, (x + 0.5) / sw * n - 0.5));
    const gx0 = Math.floor(gx);
    const tx = gx - gx0;
    const gx1 = Math.min(n - 1, gx0 + 1);
    const a = src[gy0 * n + gx0];
    const b = src[gy0 * n + gx1];
    const c = src[gy1 * n + gx0];
    const d = src[gy1 * n + gx1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const luma = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      const logL = Math.log(Math.max(luma / 255, 0.002));
      const sample = at(field, x, y);
      const local = at(spread, x, y);
      const amount = chromas.length ? (Number.isFinite(strength) ? strength : 1) : 1;
      const scale = local > 0.0001 && target > 0.0001 ? Math.min(2, Math.max(0.5, target / local)) : 1;
      const gain = Math.min(4, Math.max(0.25, Math.exp(amount * ((mean - sample) + (logL - sample) * (scale - 1)))));
      buf[i] = Math.max(0, Math.min(255, buf[i] * gain));
      buf[i + 1] = Math.max(0, Math.min(255, buf[i + 1] * gain));
      buf[i + 2] = Math.max(0, Math.min(255, buf[i + 2] * gain));
    }
  }
}

// images: RGBA buffers of W x H, the first one guides the cut. Returns the frame contents of each.
export function tileImages(images, W, H, frame, sides, opts) {
  const cw = Math.max(8, Math.min(W, Math.round(frame.w * W)));
  const ch = Math.max(8, Math.min(H, Math.round(frame.h * H)));
  const cx = Math.max(0, Math.min(W - cw, Math.round(frame.x * W)));
  const cy = Math.max(0, Math.min(H - ch, Math.round(frame.y * H)));
  // Only the frame plus the margins the bands read from is copied and blended.
  const margin = (side, size, avail) => (sides[side].on ? Math.min(Math.round(sides[side].b * size), avail) : 0);
  const mL = margin('right', cw, cx);
  const mR = margin('left', cw, W - cx - cw);
  const mT = margin('down', ch, cy);
  const mB = margin('up', ch, H - cy - ch);
  const sw = cw + mL + mR;
  const sh = ch + mT + mB;
  const bufs = images.map((img) => {
    const sub = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const at = ((cy - mT + y) * W + cx - mL) * 4;
      sub.set(img.subarray(at, at + sw * 4), y * sw * 4);
    }
    return sub;
  });
  const fx = mL;
  const fy = mT;
  if (opts.even) evenBuffer(bufs[0], sw, opts.lightColors, opts.lightRange, opts.lightStrength);
  const clipped = [];
  const pairX = sides.left.on && sides.right.on ? 0.5 : 1;
  const pairY = sides.up.on && sides.down.on ? 0.5 : 1;
  if (sides.left.on && blendSide(bufs, sh, cw, W - cx - cw, sides.left, pairX, opts,
    fx, 1, sw, cw)) clipped.push('left');
  if (sides.right.on && blendSide(bufs, sh, cw, cx, sides.right, pairX, opts,
    fx + cw - 1, -1, sw, -cw)) clipped.push('right');
  const vOpts = Object.assign({}, opts, { wrapAlong: sides.left.on || sides.right.on });
  if (sides.up.on && blendSide(bufs, cw, ch, H - cy - ch, sides.up, pairY, vOpts,
    fy * sw + fx, sw, 1, ch * sw)) clipped.push('up');
  if (sides.down.on && blendSide(bufs, cw, ch, cy, sides.down, pairY, vOpts,
    (fy + ch - 1) * sw + fx, -sw, 1, -ch * sw)) clipped.push('down');
  const out = bufs.map((buf) => {
    if (sw !== cw || fy) {
      for (let y = 0; y < ch; y++) {
        const at = ((fy + y) * sw + fx) * 4;
        buf.copyWithin(y * cw * 4, at, at + cw * 4);
      }
    }
    return buf.subarray(0, cw * ch * 4);
  });
  return { images: out, w: cw, h: ch, x: cx, y: cy, clipped };
}
