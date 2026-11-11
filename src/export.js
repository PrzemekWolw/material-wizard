import { TERRAIN_GROUPS } from './utils/terrain.js';

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

async function deflateRaw(data) {
  const packed = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  return packed.length < data.length ? packed : null;
}

async function inflateRaw(data, size) {
  const out = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  if (out.length !== size) throw new Error('bad zip size');
  return out;
}

function u16(n) { return [n & 255, (n >> 8) & 255]; }
function u32(n) { return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]; }

// Already compressed, so a deflate attempt only costs time.
const STORED = /\.(png|jpe?g|webp)$/i;

export async function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const raw = file.data;
    const packed = STORED.test(file.name) ? null : await deflateRaw(raw);
    const data = packed || raw;
    const method = packed ? 8 : 0;
    const crc = crc32(raw);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(name.length), ...u16(0),
    ];
    parts.push(new Uint8Array(local), name, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  }
  let centralSize = 0;
  central.forEach((p) => { centralSize += p.length; });
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  const write = (chunk) => { out.set(chunk, p); p += chunk.length; };
  parts.forEach(write);
  central.forEach(write);
  write(end);
  return out;
}

const MAP_SLOTS = ['height', 'normal', 'roughness', 'metallic', 'ao', 'opacity'];

// Reads a zip from zipStore, or an older stored zip. Checks each entry's size and CRC.
export async function unzipStore(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  if (p > bytes.length) throw new Error('bad zip');
  const files = {};
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip');
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const packed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    if (local + 30 > bytes.length) throw new Error('bad zip');
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > bytes.length) throw new Error('truncated zip');
    const stored = bytes.subarray(start, start + packed);
    let data;
    if (method === 0) {
      if (stored.length !== size) throw new Error('bad zip size');
      data = stored;
    } else if (method === 8) data = await inflateRaw(stored, size);
    else throw new Error('unsupported zip');
    if (crc32(data) !== crc) throw new Error('bad zip checksum');
    files[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Checks a project zip. Throws with a short reason, or returns the session and its files.
export async function readProject(bytes) {
  const files = await unzipStore(bytes);
  if (!files['session.json']) throw new Error('missing session.json');
  let session;
  try { session = JSON.parse(new TextDecoder().decode(files['session.json'])); }
  catch (e) { throw new Error('bad session.json'); }
  if (typeof session.materialWizardSession !== 'number') throw new Error('not a project');
  const photo = session.photo && files[session.photo] ? session.photo : Object.keys(files).find((name) => name.startsWith('photo.'));
  if (!photo) throw new Error('missing photo');
  for (const name of session.maps || []) {
    if (!MAP_SLOTS.includes(name) || !files['maps/' + name + '.png']) throw new Error('missing map ' + name);
  }
  for (let i = 0; i < (session.lights || []).length; i++) {
    if (!files['lights/' + i + '.png']) throw new Error('missing light');
  }
  if (session.mask && !files['mask.png']) throw new Error('missing mask');
  if (session.layers) {
    for (const which of ['detail', 'macro']) {
      const layer = session.layers[which];
      if (!layer || !layer.photo) continue;
      const dir = 'layers/' + which + '/';
      if (!files[dir + layer.photo]) throw new Error('missing photo');
      for (const name of layer.maps || []) {
        if (!MAP_SLOTS.includes(name) || !files[dir + 'maps/' + name + '.png']) throw new Error('missing map ' + name);
      }
      for (let i = 0; i < (layer.lights || []).length; i++) {
        if (!files[dir + 'lights/' + i + '.png']) throw new Error('missing light');
      }
      if (layer.mask && !files[dir + 'mask.png']) throw new Error('missing mask');
    }
  }
  return { session, files, photo };
}

// Encodes without copying the pixels. Works in the page and in a worker.
export async function pngBytes(rgba, w, h) {
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function pngChunk(type, data) {
  const typed = new Uint8Array(4 + data.length);
  typed.set(new TextEncoder().encode(type), 0);
  typed.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  return out;
}

// 8-bit grayscale PNG. Pixel (x, y) is pixels[y * stride + x * step]: the R channel of RGBA by default,
// or a packed gray buffer with step 1. Rows use the Up filter.
export async function grayPngBytes(pixels, w, h, stride = w * 4, step = 4) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w + 1);
    raw[row] = 2;
    for (let x = 0; x < w; x++) {
      const v = pixels[y * stride + x * step];
      const up = y ? pixels[(y - 1) * stride + x * step] : 0;
      raw[row + 1 + x] = (v - up) & 255;
    }
  }
  const zlib = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib), pngChunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  parts.forEach((part) => { out.set(part, p); p += part.length; });
  return out;
}

export function downloadBytes(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const ANNOTATIONS = ['ASPHALT', 'SOLID_LINE', 'DASHED_LINE', 'ZEBRA_CROSSING', 'DIRT'];
export { ANNOTATIONS };

export function materialDocument(opts) {
  const folder = opts.folder.endsWith('/') ? opts.folder : opts.folder + '/';
  const n = opts.name;
  const stage = {
    baseColorMap: folder + n + '_b.color.png',
    normalMap: folder + n + '_nm.normal.png',
    roughnessMap: folder + n + '_r.dataR.png',
    metallicMap: folder + n + '_m.dataR.png',
    ambientOcclusionMap: folder + n + '_ao.dataR.png',
    roughnessFactor: round3(opts.roughnessFactor),
    metallicFactor: round3(opts.metallicFactor),
    normalMapStrength: round3(opts.normalMapStrength),
    opacityFactor: round3(opts.opacityFactor),
  };
  const tint = opts.baseColorFactor;
  if (tint && tint.some((v) => v < 0.999)) stage.baseColorFactor = [round3(tint[0]), round3(tint[1]), round3(tint[2]), 1];
  if (opts.includeOpacity) stage.opacityMap = folder + n + '_o.dataR.png';
  const mat = {
    name: n,
    mapTo: n,
    class: 'Material',
    Stages: [stage, {}, {}, {}],
    version: 1.5,
  };
  if (opts.profile === 'vehicle') mat.dynamicCubemap = true;
  if (opts.profile === 'road') {
    mat.translucent = true;
    mat.translucentZWrite = true;
    mat.alphaRef = opts.alphaRef;
    mat.castShadows = false;
    mat.materialTag0 = 'RoadAndPath';
    mat.materialTag1 = 'beamng';
    mat.annotation = opts.annotation;
  }
  return { [n]: mat };
}

// Detail and macro files of a terrain material, by group suffix.
export function terrainFiles(name) {
  return TERRAIN_GROUPS.map(([group, s]) => ({ group, suffix: s, detail: 't_' + name + '_' + s + '.png', macro: 't_macro_' + name + '_' + s + '.png' }));
}

// A TerrainMaterial entry. The base textures are placeholders for the level's shared t_terrain_base_* set.
export function terrainDocument(opts) {
  const folder = opts.folder.endsWith('/') ? opts.folder : opts.folder + '/';
  const level = (/^\/?levels\/([^/]+)\//i.exec(folder) || [])[1] || 'example';
  const baseFolder = '/levels/' + level + '/art/terrains/';
  const t = opts.terrain;
  const n = opts.name;
  const mat = { name: n, internalName: n, class: 'TerrainMaterial', groundmodelName: opts.groundmodel, annotation: opts.annotation };
  terrainFiles(n).forEach(({ group, suffix, detail, macro }) => {
    const s = t.strengths[group].map(round3);
    mat[group + 'BaseTex'] = baseFolder + 't_terrain_base_' + suffix + '.png';
    mat[group + 'BaseTexSize'] = t.sizes[0];
    mat[group + 'MacroTex'] = folder + macro;
    mat[group + 'MacroTexSize'] = t.sizes[1];
    mat[group + 'MacroStrength'] = [s[0], s[1]];
    mat[group + 'DetailTex'] = folder + detail;
    mat[group + 'DetailTexSize'] = t.sizes[2];
    mat[group + 'DetailStrength'] = [s[2], s[3]];
  });
  mat.macroDistances = t.macroDistances.slice();
  mat.detailDistances = t.detailDistances.slice();
  mat.macroDistAtten = t.macroDistAtten.map(round3);
  mat.detailDistAtten = t.detailDistAtten.map(round3);
  return { [n]: mat };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// Fills {prefix}, {name} and {n} in a name pattern; {n:02} pads the number. Characters a material
// name cannot hold become _.
export function materialName(pattern, values) {
  const out = String(pattern || '{prefix}{name}').replace(/\{(\w+)(?::(\d+))?\}/g, (match, key, pad) => {
    const value = values[key];
    if (value == null) return '';
    return pad ? String(value).padStart(Number(pad), '0') : String(value);
  });
  return out.replace(/[^a-z0-9_-]+/gi, '_') || values.name;
}

export function textureLengthFor(roadWidth, outW, outH) {
  if (!outW || !outH) return 0;
  return roadWidth * (outH / outW);
}
