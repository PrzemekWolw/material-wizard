// Where the tile repeats itself: each patch of a downscaled copy is matched against every other place
// on the wrapped tile. heat is 0 for unique areas and 255 where a near copy exists elsewhere.
export function repetitionMap(rgba, w, h, size = 64, patch = 8) {
  const scale = Math.min(1, size / Math.max(w, h));
  const s = Math.max(patch * 3, Math.round(w * scale));
  const t = Math.max(patch * 3, Math.round(h * scale));
  const luma = new Float32Array(s * t);
  const count = new Float32Array(s * t);
  for (let y = 0; y < h; y++) {
    const ly = Math.min(t - 1, Math.floor(y * t / h));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = ly * s + Math.min(s - 1, Math.floor(x * s / w));
      luma[j] += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      count[j] += 1;
    }
  }
  for (let i = 0; i < luma.length; i++) luma[i] /= Math.max(1, count[i]);
  const n = patch * patch;
  // Zero-mean, unit-length patch at (x, y), wrapped; null when the patch is flat.
  const patchAt = (x, y) => {
    const v = new Float32Array(n);
    let mean = 0;
    for (let py = 0; py < patch; py++) {
      for (let px = 0; px < patch; px++) {
        const value = luma[((y + py) % t) * s + (x + px) % s];
        v[py * patch + px] = value;
        mean += value;
      }
    }
    mean /= n;
    let len = 0;
    for (let i = 0; i < n; i++) { v[i] -= mean; len += v[i] * v[i]; }
    if (len < n * 4) return null;
    len = Math.sqrt(len);
    for (let i = 0; i < n; i++) v[i] /= len;
    return v;
  };
  const candidates = [];
  for (let y = 0; y < t; y++) {
    for (let x = 0; x < s; x++) candidates.push({ x, y, v: patchAt(x, y) });
  }
  const cell = 4;
  const cw = Math.ceil(s / cell);
  const ch = Math.ceil(t / cell);
  const heat = new Uint8Array(cw * ch);
  const near = (a, b, size) => Math.min(Math.abs(a - b), size - Math.abs(a - b)) < patch;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const x = cx * cell;
      const y = cy * cell;
      const a = patchAt(x, y);
      if (!a) continue;
      let best = 0;
      for (const c of candidates) {
        if (!c.v || (near(c.x, x, s) && near(c.y, y, t))) continue;
        let dot = 0;
        for (let i = 0; i < n; i++) dot += a[i] * c.v[i];
        if (dot > best) best = dot;
      }
      heat[cy * cw + cx] = Math.round(Math.min(1, Math.max(0, (best - 0.75) / 0.2)) * 255);
    }
  }
  return { heat, w: cw, h: ch };
}
