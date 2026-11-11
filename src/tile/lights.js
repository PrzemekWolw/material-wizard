export function solveLights(images, lights, w, h) {
  const count = images.length;
  const albedo = new Uint8Array(w * h * 4);
  const normal = new Uint8Array(w * h * 4);
  const dirs = lights.map((light) => {
    const az = light.az * Math.PI / 180;
    const el = light.el * Math.PI / 180;
    return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  });
  for (let p = 0; p < w * h; p++) {
    const samples = [];
    for (let i = 0; i < count; i++) {
      const o = p * 4;
      const r = images[i][o];
      const g = images[i][o + 1];
      const b = images[i][o + 2];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples.push({ i, y, r, g, b });
    }
    samples.sort((a, b) => a.y - b.y);
    const used = samples.length > 3 ? samples.slice(1, -1) : samples;
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    for (const s of used) {
      const L = dirs[s.i];
      a00 += L[0] * L[0]; a01 += L[0] * L[1]; a02 += L[0] * L[2];
      a11 += L[1] * L[1]; a12 += L[1] * L[2]; a22 += L[2] * L[2];
      b0 += L[0] * s.y; b1 += L[1] * s.y; b2 += L[2] * s.y;
    }
    const m = solve3(a00, a01, a02, a11, a12, a22, b0, b1, b2);
    const len = Math.hypot(m[0], m[1], m[2]) || 1;
    const nx = m[0] / len;
    const ny = m[1] / len;
    const nz = Math.abs(m[2] / len);
    const o = p * 4;
    normal[o] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
    normal[o + 1] = Math.max(0, Math.min(255, Math.round((-ny * 0.5 + 0.5) * 255)));
    normal[o + 2] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
    normal[o + 3] = 255;
    let ar = 0, ag = 0, ab = 0, an = 0;
    for (const s of used) {
      const shade = Math.max(0.08, dirs[s.i][0] * nx + dirs[s.i][1] * ny + dirs[s.i][2] * nz);
      ar += s.r / shade; ag += s.g / shade; ab += s.b / shade; an++;
    }
    albedo[o] = Math.max(0, Math.min(255, Math.round(ar / an)));
    albedo[o + 1] = Math.max(0, Math.min(255, Math.round(ag / an)));
    albedo[o + 2] = Math.max(0, Math.min(255, Math.round(ab / an)));
    albedo[o + 3] = 255;
  }
  return { albedo, normal };
}

function solve3(a00, a01, a02, a11, a12, a22, b0, b1, b2) {
  const m = [
    [a00, a01, a02, b0],
    [a01, a11, a12, b1],
    [a02, a12, a22, b2],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    const tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
    const div = m[col][col] || 1e-8;
    for (let c = col; c < 4; c++) m[col][c] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}
