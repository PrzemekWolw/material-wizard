function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function u16(n) { return [n & 255, (n >> 8) & 255]; }
function u32(n) { return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]; }

export function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ];
    parts.push(new Uint8Array(local), name, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
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

export function pngBytes(rgba, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
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
  };
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

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

export function textureLengthFor(roadWidth, outW, outH) {
  if (!outW || !outH) return 0;
  return roadWidth * (outH / outW);
}
