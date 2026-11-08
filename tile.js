function nextPot(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function fftRadix(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (Math.PI * 2 / len) * (inverse ? 1 : -1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * cRe - im[i + k + half] * cIm;
        const vIm = re[i + k + half] * cIm + im[i + k + half] * cRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

function fft2(re, im, w, h, inverse) {
  const rowRe = new Float64Array(w);
  const rowIm = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { rowRe[x] = re[y * w + x]; rowIm[x] = im[y * w + x]; }
    fftRadix(rowRe, rowIm, w, inverse);
    for (let x = 0; x < w; x++) { re[y * w + x] = rowRe[x]; im[y * w + x] = rowIm[x]; }
  }
  const colRe = new Float64Array(h);
  const colIm = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colRe[y] = re[y * w + x]; colIm[y] = im[y * w + x]; }
    fftRadix(colRe, colIm, h, inverse);
    for (let y = 0; y < h; y++) { re[y * w + x] = colRe[y]; im[y * w + x] = colIm[y]; }
  }
}

function lumaOf(rgba, i) {
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
  const o4 = off * 4;
  for (const buf of bufs) {
    if (ds === 1) {
      for (let t = 0; t < band; t++) {
        const row = (d0 + t * dt) * 4;
        for (let s = 0; s < along; s++) mixPixel(buf, row + s * 4, o4, mask[s * band + t] * maxW);
      }
    } else {
      for (let s = 0; s < along; s++) {
        const row = s * band;
        for (let t = 0; t < band; t++) mixPixel(buf, (d0 + t * dt + s * ds) * 4, o4, mask[row + t] * maxW);
      }
    }
  }
  return clipped;
}

function mixPixel(buf, d, o4, m) {
  if (m <= 0) return;
  const o = d + o4;
  buf[d] += (buf[o] - buf[d]) * m;
  buf[d + 1] += (buf[o + 1] - buf[d + 1]) * m;
  buf[d + 2] += (buf[o + 2] - buf[d + 2]) * m;
  buf[d + 3] += (buf[o + 3] - buf[d + 3]) * m;
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

export function solveLights(images, lights, w, h) {
  const count = images.length;
  const albedo = new Uint8Array(w * h * 4);
  const normal = new Uint8Array(w * h * 4);
  const dirs = lights.map((light) => {
    const az = light.az * Math.PI / 180;
    const el = light.el * Math.PI / 180;
    return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  });
  for (let p = 0; p < w * h; p++) {
    const samples = [];
    for (let i = 0; i < count; i++) {
      const o = p * 4;
      const r = images[i][o];
      const g = images[i][o + 1];
      const b = images[i][o + 2];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples.push({ i, y, r, g, b });
    }
    samples.sort((a, b) => a.y - b.y);
    const used = samples.length > 3 ? samples.slice(1, -1) : samples;
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    for (const s of used) {
      const L = dirs[s.i];
      a00 += L[0] * L[0]; a01 += L[0] * L[1]; a02 += L[0] * L[2];
      a11 += L[1] * L[1]; a12 += L[1] * L[2]; a22 += L[2] * L[2];
      b0 += L[0] * s.y; b1 += L[1] * s.y; b2 += L[2] * s.y;
    }
    const m = solve3(a00, a01, a02, a11, a12, a22, b0, b1, b2);
    const len = Math.hypot(m[0], m[1], m[2]) || 1;
    const nx = m[0] / len;
    const ny = m[1] / len;
    const nz = Math.abs(m[2] / len);
    const o = p * 4;
    normal[o] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
    normal[o + 1] = Math.max(0, Math.min(255, Math.round((-ny * 0.5 + 0.5) * 255)));
    normal[o + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
    normal[o + 3] = 255;
    let ar = 0, ag = 0, ab = 0, an = 0;
    for (const s of used) {
      const shade = Math.max(0.08, dirs[s.i][0] * nx + dirs[s.i][1] * ny + dirs[s.i][2] * nz);
      ar += s.r / shade; ag += s.g / shade; ab += s.b / shade; an++;
    }
    albedo[o] = Math.max(0, Math.min(255, Math.round(ar / an)));
    albedo[o + 1] = Math.max(0, Math.min(255, Math.round(ag / an)));
    albedo[o + 2] = Math.max(0, Math.min(255, Math.round(ab / an)));
    albedo[o + 3] = 255;
  }
  return { albedo, normal };
}

function solve3(a00, a01, a02, a11, a12, a22, b0, b1, b2) {
  const m = [
    [a00, a01, a02, b0],
    [a01, a11, a12, b1],
    [a02, a12, a22, b2],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    const tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
    const div = m[col][col] || 1e-8;
    for (let c = col; c < 4; c++) m[col][c] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
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
