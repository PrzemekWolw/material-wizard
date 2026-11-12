import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { grayPngBytes, readProject, zipStore } from '../src/export.js';

function u16(n) { return [n & 255, n >> 8]; }
function u32(n) {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (~c) >>> 0;
}

function storedZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = file.data;
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc32(data)), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ];
    parts.push(new Uint8Array(local), name, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc32(data)), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  }
  let centralSize = 0;
  central.forEach((part) => { centralSize += part.length; });
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  [...parts, ...central, end].forEach((part) => { out.set(part, p); p += part.length; });
  return out;
}

function projectFiles() {
  const session = new TextEncoder().encode(JSON.stringify({ materialWizardSession: 1, version: '0.2.0', maps: [], lights: [] }));
  const photo = new Uint8Array(64);
  for (let i = 0; i < photo.length; i++) photo[i] = (i * 17 + 3) & 255;
  return [
    { name: 'session.json', data: session },
    { name: 'photo.png', data: photo },
  ];
}

test('zip round trip keeps the bytes', async () => {
  const files = projectFiles();
  const project = await readProject(await zipStore(files));
  assert.equal(project.session.materialWizardSession, 1);
  assert.equal(project.photo, 'photo.png');
  assert.deepEqual(project.files['photo.png'], files[1].data);
  assert.deepEqual(project.files['session.json'], files[0].data);
});

test('a stored zip still opens', async () => {
  const files = projectFiles();
  const project = await readProject(storedZip(files));
  assert.deepEqual(project.files['photo.png'], files[1].data);
});

function withHistory(history, extra = []) {
  const files = projectFiles();
  const session = JSON.parse(new TextDecoder().decode(files[0].data));
  files[0].data = new TextEncoder().encode(JSON.stringify({ ...session, history }));
  return files.concat(extra);
}

test('undo history is kept when every step points at a stored entry', async () => {
  const step = { photo: 'history/img/0.png', slots: { albedo: 'history/img/0.png', height: 'photo.png' }, lights: [], mask: null, values: { 'p:delight': '1' } };
  const history = { v: 1, undo: [step], redo: [], layers: { macro: { undo: [step], redo: [] } } };
  const project = await readProject(await zipStore(withHistory(history, [{ name: 'history/img/0.png', data: new Uint8Array([1, 2, 3]) }])));
  assert.equal(project.historyDropped, false);
  assert.equal(project.history.undo[0].values['p:delight'], '1');
});

test('a broken undo history is dropped, the project still opens', async () => {
  const missing = { v: 1, undo: [{ photo: 'history/img/9.png', slots: {}, lights: [] }], redo: [] };
  const project = await readProject(await zipStore(withHistory(missing)));
  assert.equal(project.history, null);
  assert.equal(project.historyDropped, true);
  assert.equal(project.photo, 'photo.png');
  const wrongLayer = await readProject(await zipStore(withHistory({ v: 1, undo: [], redo: [], layers: { other: { undo: [], redo: [] } } })));
  assert.equal(wrongLayer.historyDropped, true);
  const none = await readProject(await zipStore(projectFiles()));
  assert.equal(none.history, null);
  assert.equal(none.historyDropped, false);
});

test('a flipped byte and a short file are rejected', async () => {
  const bytes = await zipStore(projectFiles());
  const flipped = bytes.slice();
  flipped[80] ^= 0xff;
  await assert.rejects(() => readProject(flipped));
  await assert.rejects(() => readProject(bytes.subarray(0, bytes.length - 12)));
});

test('gray png decodes back to the same pixels', async () => {
  const rgba = new Uint8Array([10, 1, 2, 255, 20, 3, 4, 255, 30, 5, 6, 255, 40, 7, 8, 255]);
  const png = await grayPngBytes(rgba, 2, 2);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let idat = null;
  while (p < png.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === 'IDAT') idat = png.subarray(p + 8, p + 8 + len);
    p += 12 + len;
  }
  const raw = inflateSync(idat);
  const got = [];
  for (let y = 0; y < 2; y++) {
    assert.equal(raw[y * 3], 2);
    for (let x = 0; x < 2; x++) {
      const up = y ? got[(y - 1) * 2 + x] : 0;
      got.push((raw[y * 3 + 1 + x] + up) & 255);
    }
  }
  assert.deepEqual(got, [10, 20, 30, 40]);
});
