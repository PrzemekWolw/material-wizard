function random(seed) {
  let s = (Math.imul(seed | 0, 2654435761) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Texture bombing: copies round patches of the tile to other places with soft edges. Positions wrap
// around the tile, so its edges stay seamless. Every image gets the same patches. Patches are offset
// and sometimes turned 180 degrees; the normal map at normalIndex gets its x and y flipped with them.
export function bombImages(images, w, h, amount, seed, normalIndex = -1) {
  if (!(amount > 0)) return images;
  const rand = random(seed);
  const sources = images.map((img) => img.slice());
  const count = Math.max(1, Math.round(amount * 16));
  for (let k = 0; k < count; k++) {
    const r = (0.08 + 0.14 * rand()) * Math.min(w, h);
    const cx = Math.floor(rand() * w);
    const cy = Math.floor(rand() * h);
    const sx = Math.floor(rand() * w);
    const sy = Math.floor(rand() * h);
    const turn = rand() < 0.5 ? -1 : 1;
    const R = Math.ceil(r);
    images.forEach((img, i) => {
      const src = sources[i];
      const flip = i === normalIndex && turn < 0;
      for (let dy = -R; dy <= R; dy++) {
        const row = (((cy + dy) % h) + h) % h * w;
        const srow = (((sy + dy * turn) % h) + h) % h * w;
        for (let dx = -R; dx <= R; dx++) {
          const t = Math.sqrt(dx * dx + dy * dy) / r;
          if (t >= 1) continue;
          const f = t < 0.5 ? 0 : (t - 0.5) * 2;
          const m = 1 - f * f * (3 - 2 * f);
          const d = (row + (((cx + dx) % w) + w) % w) * 4;
          const s = (srow + (((sx + dx * turn) % w) + w) % w) * 4;
          for (let c = 0; c < 3; c++) {
            const v = flip && c < 2 ? 255 - src[s + c] : src[s + c];
            img[d + c] = Math.round(img[d + c] + (v - img[d + c]) * m);
          }
        }
      }
    });
  }
  return images;
}
