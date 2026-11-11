
export function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPow2(n) {
  return n >= 1 && (n & (n - 1)) === 0;
}

export function potShape(w, h) {
  if (!isPow2(w) || !isPow2(h)) return null;
  const g = Math.min(w, h);
  return (w / g) + ':' + (h / g);
}

export function shapeRatio(shape) {
  const parts = String(shape).split(':');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (parts.length !== 2 || !a || !b) return null;
  return { a, b };
}

export function sizeFromRatio(max, ratio) {
  if (ratio.a >= ratio.b) return { w: max, h: Math.max(1, Math.round(max * ratio.b / ratio.a)) };
  return { w: Math.max(1, Math.round(max * ratio.a / ratio.b)), h: max };
}

export function workingSize(image, max, shape) {
  const detected = potShape(image.width, image.height);
  if (max === 'source' && (!detected || shape === 'auto' || shape === detected)) {
    return { w: image.width, h: image.height };
  }
  let ratio = shapeRatio(shape);
  if (!ratio) {
    if (detected) ratio = shapeRatio(detected);
    else {
      const aspect = image.width / Math.max(1, image.height);
      ratio = aspect < 0.75 ? { a: 1, b: 2 } : aspect > 1.5 ? { a: 2, b: 1 } : { a: 1, b: 1 };
    }
  }
  const longSide = max === 'source' ? Math.max(image.width, image.height) : max;
  return sizeFromRatio(longSide, ratio);
}
