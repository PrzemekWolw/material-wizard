import assert from 'node:assert/strict';
import test from 'node:test';
import { tileImages } from '../src/tile/index.js';

const off = { on: false, a: 0, b: 0 };
const none = { left: off, right: off, up: off, down: off };

function variance(values) {
  let mean = 0;
  values.forEach((v) => { mean += v; });
  mean /= values.length;
  let sum = 0;
  values.forEach((v) => { sum += (v - mean) * (v - mean); });
  return sum / values.length;
}

test('a full frame with blending off is unchanged', () => {
  const img = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < img.length; i += 4) {
    img[i] = i & 255;
    img[i + 3] = 255;
  }
  const out = tileImages([img], 32, 32, { x: 0, y: 0, w: 1, h: 1 }, none, { cut: false, soft: 0, even: false });
  assert.equal(out.w, 32);
  assert.equal(out.h, 32);
  assert.deepEqual(out.images[0], img);
});

test('the blend keeps more contrast than a plain average', () => {
  const W = 64;
  const H = 32;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x < 32 ? ((x + y) & 1 ? 255 : 0) : 128;
      const i = (y * W + x) * 4;
      img[i] = img[i + 1] = img[i + 2] = v;
      img[i + 3] = 255;
    }
  }
  const sides = { left: { on: true, a: 0, b: 0.5 }, right: off, up: off, down: off };
  const out = tileImages([img], W, H, { x: 0, y: 0, w: 0.5, h: 1 }, sides, { cut: false, soft: 1, even: false });
  assert.equal(out.w, 32);
  const column = [];
  const source = [];
  for (let y = 0; y < out.h; y++) {
    column.push(out.images[0][(y * out.w + 8) * 4]);
    source.push(img[(y * W) * 4]);
  }
  assert.ok(variance(column) > variance(source) * 0.35);
  assert.equal(out.images[0][3], 255);
});

test('evening does not paint a dark patch into an even texture', () => {
  const W = 32;
  const H = 32;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 120 + ((x * 13 + y * 7) & 31);
      const i = (y * W + x) * 4;
      img[i] = img[i + 1] = img[i + 2] = v;
      img[i + 3] = 255;
    }
  }
  const out = tileImages([img], W, H, { x: 0, y: 0, w: 1, h: 1 }, none, { cut: false, soft: 0, even: true });
  const mean = (x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) { sum += out.images[0][(y * W + x) * 4]; n++; }
    }
    return sum / n;
  };
  assert.ok(Math.abs(mean(12, 20, 12, 20) - mean(0, 8, 0, 8)) < 8);
});

test('evening flattens a vignette', () => {
  const W = 64;
  const H = 64;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5) / W - 0.5;
      const dy = (y + 0.5) / H - 0.5;
      const v = 60 + 160 * Math.max(0, 1 - Math.hypot(dx, dy) * 2.2);
      const i = (y * W + x) * 4;
      img[i] = img[i + 1] = img[i + 2] = v;
      img[i + 3] = 255;
    }
  }
  const out = tileImages([img], W, H, { x: 0, y: 0, w: 1, h: 1 }, none, { cut: false, soft: 0, even: true });
  const mean = (x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) { sum += out.images[0][(y * W + x) * 4]; n++; }
    }
    return sum / n;
  };
  assert.ok(Math.abs(mean(24, 40, 24, 40) - mean(0, 12, 0, 12)) < 28);
});

test('evening flattens a brightness ramp', () => {
  const W = 32;
  const H = 32;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 40 + (180 * x) / (W - 1);
      const i = (y * W + x) * 4;
      img[i] = img[i + 1] = img[i + 2] = v;
      img[i + 3] = 255;
    }
  }
  const out = tileImages([img], W, H, { x: 0, y: 0, w: 1, h: 1 }, none, { cut: false, soft: 0, even: true });
  const mean = (from, to) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = from; x < to; x++) { sum += out.images[0][(y * W + x) * 4]; n++; }
    }
    return sum / n;
  };
  assert.ok(Math.abs(mean(0, 8) - mean(24, 32)) < 40);
});

test('evening pulls a harsh side and a flat side toward the same contrast', () => {
  const W = 64;
  const H = 64;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const span = x < W / 2 ? 70 : 12;
      const v = 120 + (((x * 13 + y * 7) & 255) / 255 - 0.5) * 2 * span;
      const i = (y * W + x) * 4;
      img[i] = img[i + 1] = img[i + 2] = Math.max(0, Math.min(255, v));
      img[i + 3] = 255;
    }
  }
  const out = tileImages([img], W, H, { x: 0, y: 0, w: 1, h: 1 }, none, { cut: false, soft: 0, even: true }).images[0];
  const deviation = (data, x0, x1) => {
    let mean = 0;
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { mean += data[(y * W + x) * 4]; n++; }
    mean /= n;
    let sum = 0;
    for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { const d = data[(y * W + x) * 4] - mean; sum += d * d; }
    return Math.sqrt(sum / n);
  };
  const ratio = (data) => deviation(data, 4, 24) / deviation(data, 40, 60);
  assert.ok(ratio(img) > 3);
  assert.ok(ratio(out) < ratio(img) * 0.6, 'out ' + ratio(out) + ' in ' + ratio(img));
});

test('evening by picked color leaves a different material at its own brightness', () => {
  const W = 64;
  const H = 64;
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ramp = 0.5 + (0.9 * x) / (W - 1);
      const patch = x >= 20 && x < 44 && y >= 20 && y < 48;
      const [r, g, b] = patch ? [30, 90, 80] : [200, 150, 90];
      const i = (y * W + x) * 4;
      img[i] = r * ramp;
      img[i + 1] = g * ramp;
      img[i + 2] = b * ramp;
      img[i + 3] = 255;
    }
  }
  const lin = (v) => Math.pow(v / 255, 2.2);
  const run = (picked) => tileImages([img], W, H, { x: 0, y: 0, w: 1, h: 1 }, none, {
    cut: false, soft: 0, even: true, lightColors: picked ? [[lin(200), lin(150), lin(90)]] : [], lightRange: 0.06,
  }).images[0];
  const mean = (data, x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += data[(y * W + x) * 4 + 1]; n++; }
    return sum / n;
  };
  const patchRatio = (data) => mean(data, 28, 36, 28, 40) / mean(data, 28, 36, 2, 14);
  const picked = run(true);
  const plain = run(false);
  assert.ok(Math.abs(mean(picked, 0, 10, 0, 16) - mean(picked, 54, 64, 0, 16)) < 25);
  assert.ok(Math.abs(patchRatio(picked) - patchRatio(img)) < 0.15, 'picked ' + patchRatio(picked) + ' orig ' + patchRatio(img));
  assert.ok(patchRatio(plain) > patchRatio(picked), 'plain ' + patchRatio(plain) + ' picked ' + patchRatio(picked));
});
