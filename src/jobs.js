import { tileImages, seamScore, findRepeat, dominantAngle, homographyFromQuad, warpBuffer, solveLights, bombImages, repetitionMap } from './tile/index.js';
import { grayPngBytes, pngBytes, readProject, zipStore } from './export.js';

// Pixel buffers kept between jobs, by image key, so a tiling change sends only options.
const held = new Map();

function heldData(key) {
  const entry = held.get(key);
  if (!entry) throw new Error('image not held: ' + key);
  return entry;
}

// Pure buffer jobs. They run in work.worker.js, or inline when the worker is not available.
export const JOBS = {
  hold({ key, data, w, h }) { held.set(key, { data, w, h }); },
  drop({ keys }) { keys.forEach((key) => held.delete(key)); },
  tile({ keys, w, h, frame, sides, opts, scoreX, scoreY, normalIndex = -1 }) {
    const out = tileImages(keys.map((key) => heldData(key).data), w, h, frame, sides, opts);
    if (opts.bomb) bombImages(out.images, out.w, out.h, opts.bomb.amount, opts.bomb.seed, normalIndex);
    return {
      images: out.images,
      w: out.w,
      h: out.h,
      clipped: out.clipped,
      scores: {
        x: scoreX ? seamScore(out.images[0], out.w, out.h, 'x') : null,
        y: scoreY ? seamScore(out.images[0], out.w, out.h, 'y') : null,
      },
    };
  },
  repeat({ data, w, h }) { return findRepeat(data, w, h); },
  repeatMap({ data, w, h }) { return repetitionMap(data, w, h); },
  angle({ data, w, h }) { return dominantAngle(data, w, h); },
  warp({ data, w, h, quad }) { return warpBuffer(data, w, h, homographyFromQuad(quad)); },
  lights({ images, lights, w, h }) { return solveLights(images, lights, w, h); },
  png({ data, w, h, gray, stride }) { return gray ? grayPngBytes(data, w, h, stride, 1) : pngBytes(data, w, h); },
  zip({ files }) { return zipStore(files); },
  readProject({ bytes }) { return readProject(bytes); },
};

// Every ArrayBuffer under value, for the transfer list of a result.
export function buffersOf(value, found = new Set()) {
  if (value && typeof value === 'object') {
    if (ArrayBuffer.isView(value)) found.add(value.buffer);
    else if (value instanceof ArrayBuffer) found.add(value);
    else Object.values(value).forEach((item) => buffersOf(item, found));
  }
  return [...found];
}
