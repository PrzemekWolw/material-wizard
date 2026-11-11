export function canvasFromRGBA(rgba, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return c;
}

export function imageDataOf(image, w = image.width, h = image.height) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  return data;
}

export function extract(image, channel, invert) {
  const data = imageDataOf(image);
  const d = data.data;
  if (channel === 'rgb' && !invert) return image;
  for (let i = 0; i < d.length; i += 4) {
    if (channel === 'rgb') {
      d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
    } else {
      const idx = { r: 0, g: 1, b: 2, a: 3 }[channel];
      let v = channel === 'luma' ? 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] : d[i + idx];
      if (invert) v = 255 - v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

// Turns the photo so roads run up: 'left' is a quarter turn clockwise, 'right' anticlockwise.
export function orient(image, runs) {
  if (runs !== 'left' && runs !== 'right') return image;
  const c = document.createElement('canvas');
  c.width = image.height;
  c.height = image.width;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (runs === 'left') ctx.setTransform(0, 1, -1, 0, c.width, 0);
  else ctx.setTransform(0, -1, 1, 0, 0, c.height);
  ctx.drawImage(image, 0, 0);
  return c;
}

export function paint(image, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(image, 0, 0, w, h);
  return c;
}

export function uploadPainted(set, image, w, h) {
  const c = paint(image, w, h);
  try { set(c); } finally { c.width = c.height = 0; }
}

// The file each loaded image came from, so projects and undo history can store it as is.
const sources = new WeakMap();

export function keepSource(image, blob) {
  if (blob && !/svg/i.test(blob.type)) sources.set(image, blob);
  return image;
}

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(keepSource(img, file)); };
    img.onerror = reject;
    img.src = url;
  });
}

// The original file bytes of an image, or a PNG of it when it was changed after loading.
export async function imageBytes(image) {
  const blob = sources.get(image) || await new Promise((resolve) => {
    const c = paint(image, image.width, image.height);
    c.toBlob((png) => { c.width = c.height = 0; resolve(png); }, 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export function hasSource(image) {
  return sources.has(image);
}

const ids = new WeakMap();

let nextId = 1;

export function idOf(obj) {
  if (!ids.has(obj)) ids.set(obj, nextId++);
  return ids.get(obj);
}
