// TerrainMaterial values and the distance factors of shaders/common/terrain/terrain.h.hlsl.

export const TERRAIN_GROUPS = [
  ['baseColor', 'b'],
  ['normal', 'nm'],
  ['roughness', 'r'],
  ['ao', 'ao'],
  ['height', 'h'],
];

// Typical values from the terrain docs: [macro near, macro far, detail near, detail far].
export const TERRAIN_STRENGTHS = {
  baseColor: [0.2, 0.4, 0.3, 0],
  normal: [0.5, 0.6, 0.8, 0.15],
  roughness: [0.2, 0.4, 0.3, 0],
  ao: [0.2, 0.4, 0.3, 0],
  height: [0, 0, 0, 0],
};

export const TERRAIN_DEFAULTS = {
  sizes: [256, 60, 4],
  macroDistances: [0, 10, 100, 3000],
  detailDistances: [0, 0, 30, 60],
  macroDistAtten: [1, 1],
  detailDistAtten: [1, 1],
};

export const MACRO_CAP = 1000;
export const DETAIL_CAP = 250;

// saturate((x - a) / (b - a)) with HLSL division: a zero span gives 1 past a and 0 at or before it.
function ramp(x, a, b) {
  return b > a ? Math.min(Math.max((x - a) / (b - a), 0), 1) : (x > a ? 1 : 0);
}

export function blendDetailMacro(d, dist) {
  return [ramp(dist, d[0], d[1]), ramp(dist, d[1], d[2]), ramp(dist, d[2], d[3])];
}

const lerp = (a, b, t) => a + (b - a) * t;

// calculateStrenth, called with 1 - distAtten.
export function calculateStrength(f, distAtten, strength) {
  const atten = [1 - distAtten[0], 1 - distAtten[1]];
  return lerp(lerp(atten[0] * strength[0], strength[0], f[0]), lerp(strength[1], atten[1] * strength[1], f[2]), f[1]);
}

// Macro and detail factor of one group at a distance; 0 past the sampling caps.
export function terrainFactors(t, group, dist) {
  const s = t.strengths[group];
  const macro = dist < Math.min(MACRO_CAP, t.macroDistances[3])
    ? calculateStrength(blendDetailMacro(t.macroDistances, dist), t.macroDistAtten, [s[0], s[1]]) : 0;
  const detail = dist < Math.min(DETAIL_CAP, t.detailDistances[3])
    ? calculateStrength(blendDetailMacro(t.detailDistances, dist), t.detailDistAtten, [s[2], s[3]]) : 0;
  return { macro, detail };
}

export const tParam = (group, key) => 't' + group[0].toUpperCase() + group.slice(1) + key;

// The terrain values from readParams, falling back to the defaults.
export function terrainValues(params) {
  const v = (key, def) => (typeof params[key] === 'number' ? params[key] : def);
  const list = (key, defs) => defs.map((def, i) => v(key + i, def));
  const strengths = {};
  TERRAIN_GROUPS.forEach(([group]) => {
    strengths[group] = list(tParam(group, 'Str'), TERRAIN_STRENGTHS[group]);
  });
  return {
    sizes: list('tSize', TERRAIN_DEFAULTS.sizes),
    macroDistances: list('tMacroDist', TERRAIN_DEFAULTS.macroDistances),
    detailDistances: list('tDetailDist', TERRAIN_DEFAULTS.detailDistances),
    macroDistAtten: list('tMacroAtten', TERRAIN_DEFAULTS.macroDistAtten),
    detailDistAtten: list('tDetailAtten', TERRAIN_DEFAULTS.detailDistAtten),
    strengths,
  };
}
