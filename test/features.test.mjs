import assert from 'node:assert/strict';
import test from 'node:test';
import { materialName, terrainDocument, terrainFiles } from '../src/export.js';
import { terrainFactors, terrainValues } from '../src/utils/terrain.js';
import { bombImages, repetitionMap, seamScore } from '../src/tile/index.js';
import { FLAT_CURVE, adjustValue, curveValue, lutOf } from '../src/utils/lut.js';

const flat = { inBlack: 0, inWhite: 1, gamma: 1, contrast: 1, outMin: 0, outMax: 1, curve: FLAT_CURVE.slice() };

function noise(w, h, seed) {
  let s = seed;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = (s >>> 0) & 255;
    rgba[i + 3] = 255;
  }
  return rgba;
}

test('an identity adjust has no table', () => {
  assert.equal(lutOf(flat), null);
  assert.equal(lutOf(null), null);
});

test('levels, gamma, contrast and output range', () => {
  const at = (change, x) => Math.round(adjustValue({ ...flat, ...change }, x) * 1e9) / 1e9;
  assert.equal(at({ inBlack: 0.2, inWhite: 0.6 }, 0.1), 0);
  assert.equal(at({ inBlack: 0.2, inWhite: 0.6 }, 0.4), 0.5);
  assert.equal(at({ inBlack: 0.2, inWhite: 0.6 }, 0.9), 1);
  assert.equal(at({ gamma: 2 }, 0.25), 0.5);
  assert.equal(at({ contrast: 2 }, 0.75), 1);
  assert.equal(at({ contrast: 0 }, 0.9), 0.5);
  assert.equal(at({ outMin: 0.2, outMax: 0.4 }, 0.5), 0.3);
  const lut = lutOf({ ...flat, outMin: 1, outMax: 0 });
  assert.equal(lut[0], 255);
  assert.equal(lut[255], 0);
});

test('the curve passes through its points and stays in range', () => {
  const points = [0, 0.1, 0.9, 1, 1];
  points.forEach((v, i) => assert.ok(Math.abs(curveValue(points, i / 4) - v) < 1e-9));
  for (let t = 0; t <= 1; t += 0.01) assert.ok(curveValue([0, 1, 0, 1, 0], t) >= 0 && curveValue([0, 1, 0, 1, 0], t) <= 1);
  for (let t = 0; t <= 1; t += 0.05) assert.ok(Math.abs(curveValue(FLAT_CURVE, t) - t) < 1e-9);
});

test('material name pattern', () => {
  assert.equal(materialName('{prefix}{name}', { prefix: 'ab_', name: 'stone' }), 'ab_stone');
  assert.equal(materialName('{prefix}{name}_{n:02}', { prefix: '', name: 'stone', n: 3 }), 'stone_03');
  assert.equal(materialName('{name} {n}', { name: 'old stone', n: 12 }), 'old_stone_12');
  assert.equal(materialName('{missing}', { name: 'stone' }), 'stone');
  assert.equal(materialName('', { prefix: 'p_', name: 'stone' }), 'p_stone');
});

test('the repetition map finds a copied block', () => {
  const w = 64;
  const rgba = noise(w, w, 12345);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const s = ((y + 4) * w + x + 4) * 4;
      const d = ((y + 40) * w + x + 36) * 4;
      for (let c = 0; c < 4; c++) rgba[d + c] = rgba[s + c];
    }
  }
  const map = repetitionMap(rgba, w, w);
  const cell = (x, y) => map.heat[Math.floor(y / 4) * map.w + Math.floor(x / 4)];
  assert.ok(cell(4, 4) > 200, 'source ' + cell(4, 4));
  assert.ok(cell(36, 40) > 200, 'copy ' + cell(36, 40));
  let unique = 0;
  for (let i = 0; i < map.heat.length; i++) if (map.heat[i] > 128) unique++;
  assert.ok(unique < map.heat.length * 0.15, 'hot cells ' + unique);
});

test('bombing keeps a seamless tile seamless', () => {
  const w = 96;
  const h = 64;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 128 + 60 * Math.sin(2 * Math.PI * 3 * x / w) + 50 * Math.cos(2 * Math.PI * 2 * y / h);
      rgba[i + 1] = 128 + 60 * Math.cos(2 * Math.PI * 5 * x / w + 2 * Math.PI * y / h);
      rgba[i + 2] = 128 + 60 * Math.sin(2 * Math.PI * 4 * y / h);
      rgba[i + 3] = 255;
    }
  }
  const before = [seamScore(rgba, w, h, 'x'), seamScore(rgba, w, h, 'y')];
  const [bombed] = bombImages([rgba.slice()], w, h, 1, 7);
  assert.ok(bombed.some((v, i) => v !== rgba[i]));
  const after = [seamScore(bombed, w, h, 'x'), seamScore(bombed, w, h, 'y')];
  assert.ok(after[0] < before[0] + 3 && after[1] < before[1] + 3, JSON.stringify({ before, after }));
  const [again] = bombImages([rgba.slice()], w, h, 1, 7);
  assert.deepEqual(again, bombed);
});

test('terrain factors follow the game distance ramps and caps', () => {
  const t = terrainValues({});
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);
  near(terrainFactors(t, 'normal', 0).detail, 0);
  near(terrainFactors(t, 'normal', 15).detail, 0.475);
  near(terrainFactors(t, 'normal', 45).detail, 0.075);
  near(terrainFactors(t, 'normal', 60).detail, 0);
  near(terrainFactors(t, 'normal', 5).macro, 0.25);
  near(terrainFactors(t, 'normal', 55).macro, 0.55);
  near(terrainFactors(t, 'normal', 999).macro, 0.6 * (1 - 899 / 2900));
  near(terrainFactors(t, 'normal', 1000).macro, 0);
  near(terrainFactors({ ...t, detailDistAtten: [0, 0] }, 'normal', 45).detail, 0.15);
});

test('terrain document and file names', () => {
  assert.deepEqual(terrainFiles('grass').map((f) => f.detail + ' ' + f.macro), [
    't_grass_b.png t_macro_grass_b.png', 't_grass_nm.png t_macro_grass_nm.png', 't_grass_r.png t_macro_grass_r.png',
    't_grass_ao.png t_macro_grass_ao.png', 't_grass_h.png t_macro_grass_h.png']);
  const doc = terrainDocument({ name: 'grass', folder: '/levels/italy/art/terrains', groundmodel: 'GRASS', annotation: 'NATURE', terrain: terrainValues({ tSize2: 2 }) });
  const m = doc.grass;
  assert.equal(m.class, 'TerrainMaterial');
  assert.equal(m.internalName, 'grass');
  assert.equal(m.groundmodelName, 'GRASS');
  assert.equal(m.normalDetailTex, '/levels/italy/art/terrains/t_grass_nm.png');
  assert.equal(m.normalMacroTex, '/levels/italy/art/terrains/t_macro_grass_nm.png');
  assert.equal(m.normalBaseTex, '/levels/italy/art/terrains/t_terrain_base_nm.png');
  assert.deepEqual(m.normalDetailStrength, [0.8, 0.15]);
  assert.equal(m.baseColorDetailTexSize, 2);
  assert.deepEqual(m.macroDistances, [0, 10, 100, 3000]);
  assert.equal(terrainDocument({ name: 'x', folder: '/art/x/', terrain: terrainValues({}) }).x.aoBaseTex, '/levels/example/art/terrains/t_terrain_base_ao.png');
});
