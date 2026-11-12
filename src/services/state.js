import { sunAngle } from '../modules/sun.js';
import { readZones } from '../modules/zones.js';
import { ADJUST_SLOTS, adjustOf } from '../modules/curve.js';
import { remember } from './history.js';
import { fillCopy } from './i18n.js';
import { hexColor, hexLinear } from '../utils/color.js';
import { num } from '../utils/sizes.js';

export const state = {
  original: null,
  photoBytes: null,
  photoName: null,
  sessionNote: '',
  fileNote: '',
  lights: [],
  whiteBalance: null,
  lightColors: [],
  restoring: false,
  held: null,
  projectHandle: null,
  adjustFrame: '',
};

export const COLOR_SLOTS = ['albedo', 'normal'];

export const SLOTS = [
  ['albedo', 0.5],
  ['height', 0.5],
  ['normal', 0.5],
  ['roughness', 0.5],
  ['metallic', 0],
  ['ao', 1],
  ['opacity', 1],
];

// The game multiplies each of these maps by the material's factor (normal: scales the xy of the decoded normal).

export const FACTOR_SLOTS = {
  normal: { copy: 'ui.materialWizard.maps.strength', max: 2 },
  roughness: { copy: 'ui.materialWizard.maps.factor', max: 1 },
  metallic: { copy: 'ui.materialWizard.maps.factor', max: 1 },
  opacity: { copy: 'ui.materialWizard.maps.factor', max: 1 },
};

export const canvas = document.getElementById('view');

export const drop = document.getElementById('drop');

export const warningsEl = document.getElementById('warnings');

// Render rebuilds #warnings, so a file error has to live here or the next frame deletes it.
export function showFileNote(message) {
  state.fileNote = message;
  warningsEl.textContent = message;
}

export function clearFileNote() {
  state.fileNote = '';
}

export const VIEW_OF_SLOT = { albedo: 'albedo', height: 'height', normal: 'normal', roughness: 'rough', metallic: 'metal', ao: 'ao', opacity: 'opacity' };

function controlDefault(el) {
  if (el.tagName === 'SELECT') {
    const chosen = [...el.options].find((option) => option.defaultSelected);
    return chosen ? chosen.value : el.options[0].value;
  }
  return el.defaultValue;
}

export function armResets(root) {
  root.querySelectorAll('.mw-field, .mw-text').forEach((label) => {
    const el = label.querySelector('input[type="range"], input[type="number"], select');
    if (!el || label.querySelector('.mw-reset')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mw-reset mw-round';
    button.hidden = true;
    button.dataset.title = 'ui.materialWizard.resetSetting';
    const name = label.querySelector('[data-copy]');
    if (name) {
      button.dataset.label = 'ui.materialWizard.resetNamed';
      button.dataset.labelOf = name.dataset.copy;
    }
    button.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    label.insertBefore(button, el);
  });
  fillCopy(root);
}

export function syncResets() {
  document.querySelectorAll('.mw-reset').forEach((button) => {
    const el = button.parentElement.querySelector('input[type="range"], input[type="number"], select');
    button.hidden = !el || String(el.value) === String(controlDefault(el));
  });
}

function resetControl(el) {
  remember();
  el.value = controlDefault(el);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function readParams() {
  const params = {
    delight: 0.65, highlight: 0.8, relief: 0, shadowFix: 0, targetMean: 0.18,
    evenOut: 0, brightX: 0, brightXPos: 0.5, brightY: 0, brightYPos: 0.5,
    heightRelief: 0.35, heightContrast: 1.5, heightBias: 0, heightLevel: 0,
    normalStrength: 1, normalSmooth: 0.5, flipY: false, aoDepth: 1, aoContrast: 1, metalWear: 0, metalSharp: 1,
    detailStrength: 0.7, detailCutoff: 0.65, detailAuto: true, detailFlatOnly: 0.35, atlas: false, addDetail: false,
    addAoDetail: false, aoDetailAmount: 1, aoDetailSize: 0.5, addRoughDetail: false, roughDetailAmount: 1, roughDetailSize: 0.5, addMetalDetail: false, metalDetailAmount: 1, metalDetailSize: 0.5,
    tileOn: false, tileLeft: true, tileRight: false, tileUp: true, tileDown: false,
    leftA: 0.03, leftB: 0.2, rightA: 0.03, rightB: 0.2, upA: 0.03, upB: 0.2, downA: 0.03, downB: 0.2,
    tileBlend: 'cut', tileSoft: 0.3, tileEven: true, bombAmount: 0, bombSeed: 1, crop: '', cropShape: 'auto', roadRuns: 'up', roadWidth: 7,
    cavityRough: 0.25, wearRough: 0.1, microRough: 0.15, specRough: 0.35, nvarRough: 0.2,
    roughMin: 0.15, roughMax: 0.95, roughContrast: 1, localRough: 0,
    opacityEdge: 0, opacityRagged: 0.4, opacityPatch: 0, opacityCrack: 0,
    split: 0, seamLines: false, shape: 'plane', layout: '1x1',
    size: 'source', pot: 'auto', previewSize: '2048', name: 'm_example', prefix: '', namePattern: '{prefix}{name}', folder: '/levels/example/art/textures/', alphaView: 'checker',
    profile: 'level', annotation: 'ASPHALT', alphaRef: 150, albedoFix: false,
    whiteBalance: state.whiteBalance,
    lightColors: state.lightColors.map(hexLinear),
  };
  document.querySelectorAll('[data-param]').forEach((el) => {
    const key = el.dataset.param;
    if (el.type === 'checkbox') params[key] = el.checked;
    else if (el.dataset.param === 'size' && el.value === 'source') params.size = 'source';
    else if (el.type === 'range' || el.type === 'number' || el.dataset.param === 'size' || el.dataset.param === 'alphaRef' || el.dataset.param === 'roadWidth') {
      params[key] = num(el.value, params[key]);
    } else params[key] = el.value;
  });
  params.tileX = params.tileLeft || params.tileRight;
  params.tileY = params.tileUp || params.tileDown;
  params.heightWeights = [0.2, 0.45, 0.75, 1];
  params.normalWeights = [params.band0, params.band1, params.band2, params.band3].map((v) => num(v, 0.5));
  const zones = readZones();
  params.zoneBase = zones.base;
  params.zones = zones.zones;
  params.flatColor = hexColor(document.querySelector('[data-slot-color="albedo"]').value);
  params.layoutPair = String(params.layout).split('x').map((n) => num(n, 1));
  params.light = [sunAngle.az, sunAngle.el];
  params.slots = {};
  SLOTS.forEach(([name, flat]) => {
    const field = (kind) => document.querySelector('[data-slot-' + kind + '="' + name + '"]');
    const channel = field('channel');
    const invert = field('invert');
    params.slots[name] = {
      mode: field('mode').value,
      channel: channel ? channel.value : 'rgb',
      invert: invert ? invert.checked : false,
      flat: field('flat') ? num(field('flat').value, flat) : flat,
      factor: field('factor') ? num(field('factor').value, 1) : 1,
    };
  });
  ADJUST_SLOTS.forEach((name) => { params['adjust:' + name] = adjustOf(params, name); });
  params.factors = { normal: params.slots.normal.factor, roughness: params.slots.roughness.factor, metallic: params.slots.metallic.factor, opacity: params.slots.opacity.factor };
  return params;
}

export const slotImages = {};

export function init() {
  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('.mw-reset');
    if (!button) return;
    const el = button.parentElement.querySelector('input[type="range"], input[type="number"], select');
    if (el) resetControl(el);
  });
  document.body.addEventListener('dblclick', (event) => {
    if (event.target.closest('input, select, button')) return;
    const label = event.target.closest('.mw-field, .mw-text');
    const el = label && label.querySelector('input[type="range"], input[type="number"], select');
    if (el && String(el.value) !== String(controlDefault(el))) resetControl(el);
  });
}
