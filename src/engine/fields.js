import { fieldBasis } from '../shaders/common.glsl.js';

export function addFields(e) {
  // Four blur levels, each blurred twice as wide as the one before. Levels 0 and 1 are full size and
  // feed the fine normal bands; levels 2 and 3 are half and quarter size.
  function blurPyramid(src, prefix, format = 'rgba16f') {
    let current = src;
    const levels = [];
    for (let i = 0; i < 4; i++) {
      const w = Math.max(1, e.width >> Math.max(0, i - 1));
      const h = Math.max(1, e.height >> Math.max(0, i - 1));
      const step = Math.pow(2, i);
      const horiz = e.rt('blurTmp' + format + i, w, h, format);
      const vert = e.rt(prefix + 'v' + i, w, h, format);
      e.draw('blur', horiz, { uTex: current }, { uStep: [step / e.width, 0] });
      e.draw('blur', vert, { uTex: horiz }, { uStep: [0, step / e.height] });
      levels.push(vert);
      current = vert;
    }
    return levels;
  }

  // The last pyramid level. Float, so deep shadows keep their color ratios.
  function blurCoarse(src) {
    return blurPyramid(src, 'coarse')[3];
  }

  // Lighting of the picked colors only, spread over the whole image: blur(light * mask) / blur(mask).
  // Alpha carries the mask. Other materials add nothing and take their lighting from the picked neighbors.
  // Lighting is smooth, so the blurs run on a quarter size image. Two widths: the fine one follows the
  // lighting, the wide one fills the middle of big areas that the picked colors do not reach.
  function lightField(src, coarse, picks, range) {
    const masked = e.rt('lightM', e.width, e.height, 'rgba16f');
    const uniforms = { uCount: picks.length, uRange: range };
    for (let i = 0; i < 4; i++) uniforms['uPick' + i] = picks[i] || [1, 1, 1];
    e.draw('lightmask', masked, { uSrc: src, uBlur: coarse }, uniforms);
    const sw = Math.max(1, Math.ceil(e.width / 4));
    const sh = Math.max(1, Math.ceil(e.height / 4));
    const half = e.rt('lightD', Math.max(1, Math.ceil(e.width / 2)), Math.max(1, Math.ceil(e.height / 2)), 'rgba16f');
    const small = e.rt('lightA', sw, sh, 'rgba16f');
    e.draw('copy', half, { uTex: masked }, { uFlip: 0 });
    e.draw('copy', small, { uTex: half }, { uFlip: 0 });
    const horiz = e.rt('lightH', sw, sh, 'rgba16f');
    const vert = e.rt('lightV', sw, sh, 'rgba16f');
    let current = small;
    const spread = (from, to) => {
      for (let step = from; step <= to && step * 4 <= Math.max(sw, sh); step *= 2) {
        e.draw('blurA', horiz, { uTex: current }, { uStep: [step / sw, 0] });
        e.draw('blurA', vert, { uTex: horiz }, { uStep: [0, step / sh] });
        current = vert;
      }
    };
    spread(1, 8);
    const fine = e.rt('lightF', sw, sh, 'rgba16f');
    e.draw('copy', fine, { uTex: current }, { uFlip: 0 });
    spread(16, 32);
    return { fine, wide: current };
  }

  // Mean color of the brightest 30% of a blurred image: the lit level that cast shadows are lifted to.
  function litColor(blurred) {
    const buf = e.readSmall('lit', blurred, 32);
    const lumas = [];
    for (let i = 0; i < buf.length; i += 4) lumas.push(0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]);
    const cut = [...lumas].sort((a, b) => a - b)[Math.floor(lumas.length * 0.7)];
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (lumas[i / 4] < cut) continue;
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
    }
    return [r / n / 255, g / n / 255, b / n / 255];
  }

  // Least-squares fit of a smooth field over the image: a quadratic per axis, or the first harmonic on
  // axes that tile, so the field repeats with the tile. Returns the coefficients without the constant.
  function fitField(src, periodic, useLog) {
    const n = 16;
    let current = src;
    let w = e.width;
    let h = e.height;
    for (let i = 0; Math.max(w, h) > n; i++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      const next = e.rt('fit' + i, w, h);
      e.draw('copy', next, { uTex: current }, { uFlip: 0 });
      current = next;
    }
    const buf = e.read(current);
    const A = Array.from({ length: 6 }, () => new Float64Array(7));
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < w; x++) {
        const i = (row * w + x) * 4;
        const lum = (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / 255;
        const value = useLog ? Math.log(Math.max(lum, 0.002)) : buf[i] / 255;
        const b = fieldBasis((x + 0.5) / w, 1 - (row + 0.5) / h, periodic);
        for (let r = 0; r < 6; r++) {
          for (let c = 0; c < 6; c++) A[r][c] += b[r] * b[c];
          A[r][6] += b[r] * value;
        }
      }
    }
    for (let r = 0; r < 6; r++) A[r][r] += 1e-6;
    for (let c = 0; c < 6; c++) {
      let pivot = c;
      for (let r = c + 1; r < 6; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
      [A[c], A[pivot]] = [A[pivot], A[c]];
      for (let r = 0; r < 6; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 7; k++) A[r][k] -= f * A[c][k];
      }
    }
    const coef = A.map((row, i) => row[6] / row[i]);
    return { uFitA: [coef[1], coef[2], coef[3]], uFitB: [coef[4], coef[5]], uPeriodic: periodic };
  }

  function fitLight(albedo, normal) {
    const n = 24;
    const ab = e.readSmall('fa', albedo, n);
    const nb = e.readSmall('fn', normal, n);
    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
    for (let i = 0; i < n * n; i++) {
      const y = (0.2126 * ab[i * 4] + 0.7152 * ab[i * 4 + 1] + 0.0722 * ab[i * 4 + 2]) / 255;
      const nx = nb[i * 4] / 255 * 2 - 1;
      const ny = nb[i * 4 + 1] / 255 * 2 - 1;
      a00 += nx * nx; a01 += nx * ny; a11 += ny * ny;
      b0 += nx * y; b1 += ny * y;
    }
    const det = a00 * a11 - a01 * a01 || 1e-5;
    const lx = (b0 * a11 - b1 * a01) / det;
    const ly = (b1 * a00 - b0 * a01) / det;
    const len = Math.hypot(lx, ly, 0.6) || 1;
    const light = [lx / len, ly / len, 0.6 / len];
    let shade = 0;
    for (let i = 0; i < n * n; i++) {
      const nx = nb[i * 4] / 255 * 2 - 1;
      const ny = nb[i * 4 + 1] / 255 * 2 - 1;
      const nz = nb[i * 4 + 2] / 255 * 2 - 1;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const dot = nx / nl * light[0] + ny / nl * light[1] + nz / nl * light[2];
      shade += Math.min(1, Math.max(0.15, dot));
    }
    return { light, mean: shade / (n * n) };
  }

  Object.assign(e, { blurPyramid, blurCoarse, lightField, litColor, fitField, fitLight });
}
