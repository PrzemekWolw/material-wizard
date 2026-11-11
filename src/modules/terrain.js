import { commit, remember } from '../services/history.js';
import { text } from '../services/i18n.js';
import { armResets } from '../services/state.js';
import { TERRAIN_DEFAULTS, TERRAIN_GROUPS, TERRAIN_STRENGTHS, tParam, terrainValues } from '../utils/terrain.js';

const kindSelect = document.querySelector('[data-param="kind"]');

const T = 'ui.materialWizard.terrain.';
const GROUP_COPY = { baseColor: 'albedo', normal: 'normal', roughness: 'roughness', ao: 'ao', height: 'height' };
const DEBUG_VIEWS = ['lit', 'base', 'macro', 'detail', 'bands'];

export const isTerrain = () => kindSelect.value === 'terrain';

const copy = (key) => ' data-copy="' + key + '">' + text(key);

function range(param, copyKey, min, max, step, value, tip) {
  return '<label class="mw-field"' + (tip ? ' data-title="' + tip + '"' : '') + '><span' + copy(copyKey) + '</span>'
    + '<input type="range" data-param="' + param + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + value + '"></label>';
}

function number(param, copyKey, max, value) {
  return '<label class="mw-field"><span' + copy(copyKey) + '</span>'
    + '<input type="number" data-param="' + param + '" min="0" max="' + max + '" step="any" value="' + value + '"></label>';
}

const NEAR_FAR = ['macroNear', 'macroFar', 'detailNear', 'detailFar'];
const DISTANCE_STEPS = ['distStart', 'distFull', 'distFade', 'distEnd'];

function markup() {
  const select = (param, options, tip) => '<label class="mw-field"' + (tip ? ' data-title="' + tip + '"' : '') + '><span' + copy(T + param.slice(1).toLowerCase()) + '</span><select data-param="' + param + '">'
    + options.map(([value, key]) => '<option value="' + value + '"' + copy(key) + '</option>').join('') + '</select></label>';
  return '<div class="mw-seg" id="layer-seg">'
    + '<button type="button" data-layer="detail" class="is-active" aria-pressed="true"' + copy(T + 'layerDetail') + '</button>'
    + '<button type="button" data-layer="macro" aria-pressed="false"' + copy(T + 'layerMacro') + '</button>'
    + '</div>'
    + '<p class="mw-note"' + copy(T + 'layerNote') + '</p>'
    + '<details class="mw-more" open><summary' + copy(T + 'preview') + '</summary>'
    + range('tCamHeight', T + 'camHeight', 0.5, 100, 0.1, 1.8)
    + range('tPitch', T + 'pitch', 2, 89, 1, 25)
    + '<p class="mw-note" id="terrain-distance"></p>'
    + select('tBase', [['flat', T + 'baseFlat'], ['material', T + 'baseMaterial']], T + 'baseNote')
    + select('tView', DEBUG_VIEWS.map((view) => [view, T + 'view' + view[0].toUpperCase() + view.slice(1)]))
    + '<label class="mw-check" data-title="' + T + 'blendTip"><input type="checkbox" data-param="tBlend"> <span' + copy(T + 'blend') + '</span></label>'
    + '</details>'
    + '<details class="mw-more"><summary' + copy(T + 'values') + '</summary>'
    + '<h3' + copy(T + 'sizes') + '</h3>'
    + ['sizeBase', 'sizeMacro', 'sizeDetail'].map((key, i) => number('tSize' + i, T + key, 8192, TERRAIN_DEFAULTS.sizes[i])).join('')
    + '<h3 data-title="' + T + 'distTip"' + copy(T + 'macroDist') + '</h3>'
    + DISTANCE_STEPS.map((key, i) => number('tMacroDist' + i, T + key, 10000, TERRAIN_DEFAULTS.macroDistances[i])).join('')
    + '<h3 data-title="' + T + 'distTip"' + copy(T + 'detailDist') + '</h3>'
    + DISTANCE_STEPS.map((key, i) => number('tDetailDist' + i, T + key, 10000, TERRAIN_DEFAULTS.detailDistances[i])).join('')
    + '<h3 data-title="' + T + 'attenTip"' + copy(T + 'atten') + '</h3>'
    + [0, 1].map((i) => range('tMacroAtten' + i, T + NEAR_FAR[i], 0, 1, 0.01, TERRAIN_DEFAULTS.macroDistAtten[i])).join('')
    + [0, 1].map((i) => range('tDetailAtten' + i, T + NEAR_FAR[i + 2], 0, 1, 0.01, TERRAIN_DEFAULTS.detailDistAtten[i])).join('')
    + TERRAIN_GROUPS.map(([group]) => '<h3' + copy('ui.materialWizard.slots.' + GROUP_COPY[group]) + '</h3>'
      + NEAR_FAR.map((key, i) => range(tParam(group, 'Str') + i, T + key, 0, 1, 0.01, TERRAIN_STRENGTHS[group][i])).join('')).join('')
    + '</details>';
}

// Terrain view params for the lit preview, or null for a regular material.
let yaw = 0;
export function terrainView() {
  if (!isTerrain()) return null;
  const values = {};
  document.querySelectorAll('#terrain [data-param]').forEach((el) => {
    values[el.dataset.param] = el.type === 'checkbox' ? el.checked : (el.type === 'range' || el.type === 'number' ? Number(el.value) : el.value);
  });
  const height = values.tCamHeight;
  const pitch = values.tPitch;
  document.getElementById('terrain-distance').textContent = text(T + 'distance', { d: (height / Math.sin(pitch * Math.PI / 180)).toFixed(1) });
  return {
    cam: [height, pitch, yaw],
    flatBase: values.tBase === 'flat',
    debug: DEBUG_VIEWS.indexOf(values.tView),
    blend: values.tBlend,
    values: terrainValues(values),
  };
}

export function turnTerrain(dx) {
  yaw += dx;
}

export function resetTerrainYaw() {
  yaw = 0;
}

export const TERRAIN_VIEW_PARAMS = new Set(['tCamHeight', 'tPitch', 'tBase', 'tView', 'tBlend', 'tSize0', 'tSize1', 'tSize2',
  ...[0, 1, 2, 3].flatMap((i) => ['tMacroDist' + i, 'tDetailDist' + i]),
  ...[0, 1].flatMap((i) => ['tMacroAtten' + i, 'tDetailAtten' + i]),
  ...TERRAIN_GROUPS.flatMap(([group]) => [0, 1, 2, 3].map((i) => tParam(group, 'Str') + i))]);

export function syncKind() {
  const kind = isTerrain() ? 'terrain' : 'regular';
  document.body.dataset.kind = kind;
  document.querySelectorAll('#kind-seg [data-kind]').forEach((button) => {
    const on = button.dataset.kind === kind;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

export function init() {
  const host = document.getElementById('terrain');
  host.innerHTML = markup();
  armResets(host);
  document.getElementById('kind-seg').addEventListener('click', (event) => {
    const button = event.target.closest('[data-kind]');
    if (!button || button.dataset.kind === kindSelect.value) return;
    remember();
    kindSelect.value = button.dataset.kind;
    syncKind();
    kindSelect.dispatchEvent(new Event('input', { bubbles: true }));
    kindSelect.dispatchEvent(new Event('change', { bubbles: true }));
    commit();
  });
  syncKind();
}
