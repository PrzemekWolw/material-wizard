import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { tileImages, seamScore } from '../src/tile/index.js';
import { cancelled, run } from '../src/services/worker.js';

// Node has no Worker, so these run the same jobs inline.
const off = { on: false, a: 0, b: 0 };
const sides = { left: { on: true, a: 0.05, b: 0.2 }, right: off, up: off, down: off };

function photo(w, h) {
  const img = new Uint8Array(w * h * 4);
  for (let i = 0; i < img.length; i += 4) {
    img[i] = (i * 7) & 255;
    img[i + 1] = (i >> 6) & 255;
    img[i + 2] = 90;
    img[i + 3] = 255;
  }
  return img;
}

test('a held photo tiles the same as a direct call', async () => {
  const w = 48;
  const h = 32;
  const img = photo(w, h);
  const frame = { x: 0.2, y: 0, w: 0.6, h: 1 };
  const opts = { cut: false, soft: 0.5, even: true };
  const direct = tileImages([img.slice()], w, h, frame, sides, opts);
  await run('hold', { key: 'a', data: img, w, h });
  const out = await run('tile', { keys: ['a'], w, h, frame, sides, opts, scoreX: true, scoreY: false });
  assert.deepEqual([out.w, out.h], [direct.w, direct.h]);
  assert.deepEqual(out.images[0], direct.images[0]);
  assert.equal(out.scores.x, seamScore(direct.images[0], direct.w, direct.h, 'x'));
  assert.equal(out.scores.y, null);
  await run('drop', { keys: ['a'] });
  await assert.rejects(run('tile', { keys: ['a'], w, h, frame, sides, opts }), /not held/);
});

test('a newer job on the same channel cancels the older one', async () => {
  const data = photo(16, 16);
  const first = run('angle', { data, w: 16, h: 16 }, { channel: 'c' });
  const second = run('angle', { data, w: 16, h: 16 }, { channel: 'c' });
  await assert.rejects(first, (error) => cancelled(error));
  assert.equal(typeof await second, 'number');
});

test('zip and readProject round trip, images stored as is', async () => {
  const session = new TextEncoder().encode(JSON.stringify({ materialWizardSession: 1, photo: 'photo.jpg', maps: [] }));
  const jpeg = new Uint8Array(4000).fill(7);
  const bytes = await run('zip', { files: [{ name: 'session.json', data: session }, { name: 'photo.jpg', data: jpeg }] });
  assert.ok(bytes.length > jpeg.length, 'the jpeg is stored, not deflated');
  const project = await run('readProject', { bytes });
  assert.deepEqual(project.files['photo.jpg'], jpeg);
  assert.equal(project.photo, 'photo.jpg');
});

test('a packed gray buffer encodes as an 8-bit gray PNG', async () => {
  const w = 5;
  const h = 3;
  const stride = 8;
  const data = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * stride + x] = y * 40 + x;
  const png = await run('png', { data, w, h, gray: true, stride });
  const ihdr = new DataView(png.buffer, png.byteOffset + 16, 13);
  assert.deepEqual([ihdr.getUint32(0), ihdr.getUint32(4), ihdr.getUint8(9)], [w, h, 0]);
  const idat = png.subarray(41, png.length - 16);
  const raw = inflateSync(idat);
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1));
    rows.push([...row].map((v, x) => (v + (y ? rows[y - 1][x] : 0)) & 255));
  }
  assert.deepEqual(rows[2], [80, 81, 82, 83, 84]);
});
