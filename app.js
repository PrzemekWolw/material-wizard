import { createEngine, CLASSES } from './pbr.js';
import { pngBytes, zipStore, downloadBytes, materialDocument, textureLengthFor } from './export.js';
import {
  findRepeat, autoFrame, tileImages, rotateBuffer, solveLights,
  dominantAngle, homographyFromQuad, warpBuffer, seamScore,
} from './tile.js';
import { createTileEditor, coverScale } from './tile-editor.js';

const LANGUAGES = [
  ['en-US', 'English'], ['pl_PL', 'Polski'], ['es_ES', 'Español'], ['de_DE', 'Deutsch'], ['it_IT', 'Italiano'],
];
const LANGUAGE_KEY = 'mw-language';

function languageFromCode(code) {
  if (!code) return null;
  const exact = LANGUAGES.find(([id]) => id === code);
  if (exact) return exact[0];
  const near = LANGUAGES.find(([id]) => id.slice(0, 2).toLowerCase() === String(code).slice(0, 2).toLowerCase());
  return near ? near[0] : null;
}

function pickLanguage() {
  let saved = null;
  try { saved = localStorage.getItem(LANGUAGE_KEY); } catch (e) { /* ignore */ }
  if (languageFromCode(saved)) return languageFromCode(saved);
  for (const code of navigator.languages || [navigator.language]) {
    if (languageFromCode(code)) return languageFromCode(code);
  }
  return LANGUAGES[0][0];
}

let language = pickLanguage();
const copy = await (await fetch(new URL('./content.json', import.meta.url))).json();
let translation = {};
if (language !== LANGUAGES[0][0]) {
  try {
    translation = await (await fetch(new URL('./locales/' + language + '/main.translation.json', import.meta.url))).json();
  } catch (e) { /* fall back to English */ }
}
document.documentElement.lang = language.slice(0, 2);

function text(key, vars) {
  let value = translation[key];
  if (typeof value !== 'string' || !value) {
    value = copy;
    for (const part of String(key).split('.')) {
      if (value == null) return '';
      value = value[part];
    }
  }
  if (typeof value !== 'string') return '';
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (vars[name] == null ? match : String(vars[name])));
}

function fillCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((node) => {
    const vars = node.dataset.n != null ? { n: node.dataset.n } : null;
    node.textContent = text(node.dataset.copy, vars);
  });
  root.querySelectorAll('[data-title]').forEach((node) => {
    const value = text(node.dataset.title);
    node.title = value;
    if (node.tagName === 'BUTTON' && !node.dataset.label) node.setAttribute('aria-label', value);
  });
  root.querySelectorAll('[data-label]').forEach((node) => {
    const vars = node.dataset.labelSlot ? { name: text('slots.' + node.dataset.labelSlot) } : null;
    node.setAttribute('aria-label', text(node.dataset.label, vars));
  });
  root.querySelectorAll('[data-placeholder]').forEach((node) => {
    node.placeholder = text(node.dataset.placeholder);
  });
}

fillCopy(document);
document.title = text('pageTitle');
paintRanges();

const languageSelect = document.getElementById('language');
LANGUAGES.forEach(([id, name]) => languageSelect.appendChild(new Option(name, id, false, id === language)));
languageSelect.addEventListener('change', () => {
  try { localStorage.setItem(LANGUAGE_KEY, languageSelect.value); } catch (e) { /* ignore */ }
  applyLanguage(languageSelect.value);
});

let languageToken = 0;
async function applyLanguage(code) {
  const token = ++languageToken;
  let next = {};
  if (code !== LANGUAGES[0][0]) {
    try {
      next = await (await fetch(new URL('./locales/' + code + '/main.translation.json', import.meta.url))).json();
    } catch (e) { /* fall back to English */ }
  }
  if (token !== languageToken) return;
  language = code;
  translation = next;
  document.documentElement.lang = language.slice(0, 2);
  fillCopy(document);
  document.title = text('pageTitle');
  refreshLanguage();
}

function refreshLanguage() {
  document.querySelectorAll('[data-file-name]').forEach((el) => {
    if (!slotImages[el.dataset.fileName]) el.textContent = text('maps.choose');
  });
  fillPresetList(presetList.value);
  if (repeatInfo) showRepeat();
  drawLights();
  refreshEditor();
  if (original && !gpuLost) schedule();
}

const COLOR_SLOTS = ['albedo', 'normal'];
const SLOTS = [
  ['albedo', 0.5],
  ['height', 0.5],
  ['normal', 0.5],
  ['roughness', 0.5],
  ['metallic', 0],
  ['ao', 1],
  ['opacity', 1],
];

// The game multiplies each of these maps by the material's factor (normal: scales the xy of the decoded normal).
const FACTOR_SLOTS = {
  normal: { copy: 'maps.strength', max: 2 },
  roughness: { copy: 'maps.factor', max: 1 },
  metallic: { copy: 'maps.factor', max: 1 },
  opacity: { copy: 'maps.factor', max: 1 },
};

const canvas = document.getElementById('view');
let engine = createEngine(canvas);
const drop = document.getElementById('drop');
const warningsEl = document.getElementById('warnings');
let original = null;
let pickWhite = false;
let repeatInfo = null;
let repeatSize = null;
let lights = [];
let lightQueue = null;
let timer = 0;
const lightPointer = { x: 0.3, y: 0.4 };

const root = document.documentElement;
const themeKey = 'theme';
function themeMode() {
  let mode = null;
  try { mode = localStorage.getItem(themeKey); } catch (e) { /* ignore */ }
  if (mode !== 'dark' && mode !== 'light') mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return mode;
}
function applyTheme(mode) {
  root.setAttribute('data-theme', mode);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  const toggle = document.getElementById('theme-toggle');
  toggle.firstElementChild.className = mode === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon';
  try { localStorage.setItem(themeKey, mode); } catch (e) { /* ignore */ }
}
applyTheme(themeMode());
document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

const topBar = document.querySelector('.mw-top');
function syncTopHeight() {
  root.style.setProperty('--mw-top-h', topBar.offsetHeight + 'px');
}
syncTopHeight();
new ResizeObserver(syncTopHeight).observe(topBar);

const pageEl = document.querySelector('.mw-page');
const splitEl = document.getElementById('split');
const splitKey = 'mw-preview-width';
const SPLIT_W = 24;
let leftWidth = null;
try { leftWidth = Number(localStorage.getItem(splitKey)) || null; } catch (e) { /* ignore */ }

function pageInner() {
  const style = getComputedStyle(pageEl);
  return pageEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

function applySplit() {
  if (!leftWidth) { pageEl.style.gridTemplateColumns = ''; return; }
  const max = pageInner() - SPLIT_W - 280;
  const width = Math.max(240, Math.min(max, leftWidth));
  pageEl.style.gridTemplateColumns = width + 'px ' + SPLIT_W + 'px minmax(280px, 1fr)';
}

function saveSplit() {
  try {
    if (leftWidth) localStorage.setItem(splitKey, String(Math.round(leftWidth)));
    else localStorage.removeItem(splitKey);
  } catch (e) { /* ignore */ }
}

function stageWidth() {
  return document.querySelector('.mw-stage').getBoundingClientRect().width;
}

splitEl.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  splitEl.setPointerCapture(event.pointerId);
  splitEl.classList.add('is-dragging');
  document.body.classList.add('mw-resizing');
});
splitEl.addEventListener('pointermove', (event) => {
  if (!splitEl.hasPointerCapture(event.pointerId)) return;
  const left = pageEl.getBoundingClientRect().left + parseFloat(getComputedStyle(pageEl).paddingLeft);
  leftWidth = event.clientX - left - SPLIT_W / 2;
  applySplit();
});
function endSplit(event) {
  if (!splitEl.hasPointerCapture(event.pointerId)) return;
  splitEl.releasePointerCapture(event.pointerId);
  splitEl.classList.remove('is-dragging');
  document.body.classList.remove('mw-resizing');
  leftWidth = stageWidth();
  saveSplit();
}
splitEl.addEventListener('pointerup', endSplit);
splitEl.addEventListener('pointercancel', endSplit);
splitEl.addEventListener('dblclick', () => {
  leftWidth = null;
  applySplit();
  saveSplit();
});
splitEl.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  leftWidth = stageWidth() + (event.key === 'ArrowRight' ? 40 : -40);
  applySplit();
  leftWidth = stageWidth();
  saveSplit();
});
window.addEventListener('resize', applySplit);
applySplit();

const splitHEl = document.getElementById('split-h');
const splitHKey = 'mw-preview-height';
let previewHeight = null;
try { previewHeight = Number(localStorage.getItem(splitHKey)) || null; } catch (e) { /* ignore */ }

function applySplitH() {
  if (!previewHeight) { drop.style.flex = ''; return; }
  const stage = drop.parentElement.getBoundingClientRect();
  const above = drop.getBoundingClientRect().top - stage.top;
  const max = stage.height - above - splitHEl.offsetHeight;
  drop.style.flex = '0 0 ' + Math.max(160, Math.min(max, previewHeight)) + 'px';
}

function saveSplitH() {
  try {
    if (previewHeight) localStorage.setItem(splitHKey, String(Math.round(previewHeight)));
    else localStorage.removeItem(splitHKey);
  } catch (e) { /* ignore */ }
}

splitHEl.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  splitHEl.setPointerCapture(event.pointerId);
  splitHEl.classList.add('is-dragging');
  document.body.classList.add('mw-resizing-h');
});
splitHEl.addEventListener('pointermove', (event) => {
  if (!splitHEl.hasPointerCapture(event.pointerId)) return;
  previewHeight = event.clientY - drop.getBoundingClientRect().top;
  applySplitH();
});
function endSplitH(event) {
  if (!splitHEl.hasPointerCapture(event.pointerId)) return;
  splitHEl.releasePointerCapture(event.pointerId);
  splitHEl.classList.remove('is-dragging');
  document.body.classList.remove('mw-resizing-h');
  previewHeight = drop.getBoundingClientRect().height;
  saveSplitH();
}
splitHEl.addEventListener('pointerup', endSplitH);
splitHEl.addEventListener('pointercancel', endSplitH);
splitHEl.addEventListener('dblclick', () => {
  previewHeight = null;
  applySplitH();
  saveSplitH();
});
splitHEl.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  previewHeight = drop.getBoundingClientRect().height + (event.key === 'ArrowDown' ? 40 : -40);
  applySplitH();
  previewHeight = drop.getBoundingClientRect().height;
  saveSplitH();
});
applySplitH();

const VIEW_OF_SLOT = { albedo: 'albedo', height: 'height', normal: 'normal', roughness: 'rough', metallic: 'metal', ao: 'ao', opacity: 'opacity' };
const STRIP = ['albedo', 'height', 'normal', 'rough', 'metal', 'ao', 'opacity', 'preview'];
const THUMB = 96;
const stripThumbs = {};
const slotThumbs = {};

function thumbCanvas() {
  const c = document.createElement('canvas');
  c.width = THUMB;
  c.height = THUMB;
  return c;
}

const viewSelect = document.getElementById('view-mode');
const stripHost = document.getElementById('map-strip');
STRIP.forEach((view) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mw-thumb';
  button.dataset.view = view;
  const c = thumbCanvas();
  stripThumbs[view] = c;
  button.appendChild(c);
  const span = document.createElement('span');
  span.dataset.copy = 'strip.' + view;
  span.textContent = text('strip.' + view);
  button.appendChild(span);
  stripHost.appendChild(button);
});
stripHost.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});

function showView(view) {
  viewSelect.value = view;
  zoomInput.min = String(zoomMin());
  zoomInput.dataset.title = view === 'preview' ? 'preview.zoomTip' : 'zoomTip';
  zoomInput.title = text(zoomInput.dataset.title);
  const tip = document.getElementById('lit-tip');
  if (tip) tip.hidden = view !== 'preview';
  syncViewButtons();
  if (viewZoom.zoom < zoomMin()) setZoom(viewZoom.zoom);
  else presentCurrent();
}

function syncViewButtons() {
  document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('is-active', el.dataset.view === viewSelect.value));
}

const slotHost = document.getElementById('slots');
SLOTS.forEach(([name, flat]) => {
  const label = text('slots.' + name);
  const box = document.createElement('div');
  box.className = 'mw-slot';
  box.dataset.slot = name;
  box.innerHTML = '<button type="button" class="mw-thumb mw-slot-thumb" data-view="' + VIEW_OF_SLOT[name] + '" data-title="maps.show" title="' + text('maps.show') + '"></button>'
    + '<div class="mw-slot-body">'
    + '<div class="mw-slot-head"><h3 data-copy="slots.' + name + '">' + label + '</h3>'
    + '<button type="button" class="mw-save mw-round" data-save="' + name + '" data-title="maps.save" data-label="maps.saveAs" data-label-slot="' + name + '" title="' + text('maps.save') + '" aria-label="' + text('maps.saveAs', { name: label }) + '"><i class="fa-solid fa-download"></i></button></div>'
    + '<div class="mw-seg" data-seg="' + name + '">'
    + '<button type="button" data-mode="generate" data-copy="modes.generate">' + text('modes.generate') + '</button><button type="button" data-mode="load" data-copy="modes.load">' + text('modes.load') + '</button><button type="button" data-mode="flat" data-copy="modes.flat">' + text('modes.flat') + '</button>'
    + '</div>'
    + '<select class="mw-hidden" data-slot-mode="' + name + '"><option value="generate" data-copy="modes.generate">' + text('modes.generate') + '</option><option value="load" data-copy="modes.load">' + text('modes.load') + '</option><option value="flat" data-copy="modes.flat">' + text('modes.flat') + '</option></select>'
    + '<div class="mw-row" data-when="load">'
    + '<label class="mw-file"><input type="file" data-slot-file="' + name + '" accept="image/*"><span data-file-name="' + name + '">' + text('maps.choose') + '</span></label>'
    + '<select data-slot-channel="' + name + '" data-title="maps.channel" title="' + text('maps.channel') + '"><option value="rgb">RGB</option><option value="luma">luma</option><option value="r"' + (COLOR_SLOTS.includes(name) ? '' : ' selected') + '>R</option><option value="g">G</option><option value="b">B</option><option value="a">A</option></select>'
    + '<label class="mw-check"><input type="checkbox" data-slot-invert="' + name + '"> <span data-copy="maps.invert">' + text('maps.invert') + '</span></label>'
    + '</div>'
    + (name === 'albedo'
      ? '<label class="mw-field" data-title="maps.colorTip" title="' + text('maps.colorTip') + '"><span data-copy="maps.color">' + text('maps.color') + '</span>'
        + '<input type="color" data-slot-color="albedo" value="#ffffff"></label>'
      : '<label class="mw-field" data-when="flat"><span data-copy="maps.value">' + text('maps.value') + '</span>'
        + '<input type="range" data-slot-flat="' + name + '" min="0" max="1" step="0.01" value="' + flat + '"></label>')
    + (FACTOR_SLOTS[name]
      ? '<label class="mw-field" data-title="maps.factorTip" title="' + text('maps.factorTip') + '"><span data-copy="' + FACTOR_SLOTS[name].copy + '">' + text(FACTOR_SLOTS[name].copy) + '</span>'
        + '<input type="range" data-slot-factor="' + name + '" min="0" max="' + FACTOR_SLOTS[name].max + '" step="0.01" value="1"></label>'
      : '')
    + '</div>';
  slotHost.appendChild(box);
  const c = thumbCanvas();
  slotThumbs[name] = c;
  box.querySelector('.mw-slot-thumb').appendChild(c);
});
slotHost.addEventListener('click', (event) => {
  const seg = event.target.closest('[data-mode]');
  if (seg) {
    const name = seg.parentElement.dataset.seg;
    remember();
    if (seg.dataset.mode === 'load' && !slotImages[name]) {
      document.querySelector('[data-slot-file="' + name + '"]').click();
    }
    setSlotMode(name, seg.dataset.mode);
    commit();
    schedule();
    return;
  }
  const thumb = event.target.closest('[data-view]');
  if (thumb) showView(thumb.dataset.view);
});

function setSlotMode(name, mode) {
  document.querySelector('[data-slot-mode="' + name + '"]').value = mode;
  syncSlot(name);
}

function syncSlot(name) {
  const mode = document.querySelector('[data-slot-mode="' + name + '"]').value;
  const box = slotHost.querySelector('[data-slot="' + name + '"]');
  box.querySelectorAll('[data-mode]').forEach((el) => el.classList.toggle('is-active', el.dataset.mode === mode));
  box.querySelectorAll('[data-when]').forEach((el) => el.classList.toggle('mw-hidden', el.dataset.when !== mode));
}
SLOTS.forEach(([name]) => syncSlot(name));
const orm = document.createElement('div');
orm.className = 'mw-actions mw-orm';
orm.innerHTML = '<label class="mw-text"><span data-copy="maps.unpack">' + text('maps.unpack') + '</span> <input type="file" id="orm-file" accept="image/*"></label>'
  + '<select id="orm-order"><option value="orm" data-copy="maps.orm">' + text('maps.orm') + '</option><option value="arm" data-copy="maps.rma">' + text('maps.rma') + '</option></select>';
slotHost.appendChild(orm);

const classHost = document.getElementById('class-presets');
Object.keys(CLASSES).forEach((name) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.copy = 'classes.' + name;
  button.textContent = text('classes.' + name) || name;
  button.addEventListener('click', () => {
    remember();
    document.querySelectorAll('[data-region-class]').forEach((select) => {
      select.value = name;
      setRegionMetal(select);
    });
    commit();
    schedule();
  });
  classHost.appendChild(button);
});

function setRegionMetal(select) {
  const slider = document.querySelector('[data-region-metal="' + select.dataset.regionClass + '"]');
  slider.value = CLASSES[select.value].metal;
}

const regionHost = document.getElementById('region-classes');
const metalHost = document.getElementById('region-metal');
for (let i = 0; i < 4; i++) {
  const label = document.createElement('label');
  label.className = 'mw-field';
  const nameSpan = document.createElement('span');
  nameSpan.dataset.copy = 'surface.region';
  nameSpan.dataset.n = String(i + 1);
  nameSpan.textContent = text('surface.region', { n: i + 1 });
  label.appendChild(nameSpan);
  const select = document.createElement('select');
  select.dataset.regionClass = String(i);
  Object.keys(CLASSES).forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.dataset.copy = 'classes.' + name;
    option.textContent = text('classes.' + name) || name;
    select.appendChild(option);
  });
  select.value = ['asphalt', 'concrete', 'dirt', 'paint'][i];
  label.appendChild(select);
  regionHost.appendChild(label);
  const metal = document.createElement('label');
  metal.className = 'mw-field';
  metal.dataset.regionMetalRow = String(i);
  const metalName = document.createElement('span');
  metalName.dataset.copy = 'surface.regionMetal';
  metalName.dataset.n = String(i + 1);
  metalName.textContent = text('surface.regionMetal', { n: i + 1 });
  metal.appendChild(metalName);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.dataset.regionMetal = String(i);
  metal.appendChild(slider);
  metalHost.appendChild(metal);
  setRegionMetal(select);
  select.addEventListener('input', () => setRegionMetal(select));
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  document.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('is-active', el === button));
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    const show = panel.getAttribute('data-panel') === button.dataset.tab;
    panel.classList.toggle('mw-hidden', !show);
    if (show) enterContent(panel);
  });
  if (button.dataset.tab === 'preview') showView('preview');
  refreshEditor();
});

function enterContent(panel) {
  Array.from(panel.children).forEach((child, i) => child.style.setProperty('--i', Math.min(i, 10)));
  panel.classList.remove('mw-enter');
  void panel.offsetWidth;
  panel.classList.add('mw-enter');
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hexColor(value) {
  const n = parseInt(String(value || '').replace('#', ''), 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function readParams() {
  const params = {
    delight: 0.65, highlight: 0.8, relief: 0, targetMean: 0.18,
    heightRelief: 0.35, heightContrast: 1.5, heightBias: 0,
    normalStrength: 1, normalSmooth: 0.5, flipY: false, aoDepth: 1, aoContrast: 1, metalWear: 0, metalSharp: 1,
    detailStrength: 0.7, detailCutoff: 0.65, detailAuto: true, detailFlatOnly: 0.35, atlas: false, addDetail: false,
    addAoDetail: false, aoDetailAmount: 1, addRoughDetail: false, roughDetailAmount: 1, addMetalDetail: false, metalDetailAmount: 1, mapDetailSize: 0.5,
    tileOn: false, tileLeft: true, tileRight: false, tileUp: true, tileDown: false,
    leftA: 0.03, leftB: 0.2, rightA: 0.03, rightB: 0.2, upA: 0.03, upB: 0.2, downA: 0.03, downB: 0.2,
    tileBlend: 'cut', tileSoft: 0.3, crop: '', cropShape: 'auto', roadRuns: 'up', roadWidth: 7,
    cavityRough: 0.25, wearRough: 0.1, microRough: 0.15, specRough: 0.35, nvarRough: 0.2,
    roughMin: 0.15, roughMax: 0.95, roughContrast: 1, regionCount: 3,
    opacityEdge: 0, opacityRagged: 0.4, opacityPatch: 0, opacityCrack: 0, opacityRegion: -1,
    split: 0, seamLines: false, shape: 'plane', layout: '1x1',
    size: 'source', pot: 'auto', previewSize: '2048', name: 'm_example', folder: '/levels/example/art/textures/',
    profile: 'level', annotation: 'ASPHALT', alphaRef: 150, delightLoaded: false,
    whiteBalance: whiteBalance,
  };
  document.querySelectorAll('[data-param]').forEach((el) => {
    const key = el.dataset.param;
    if (el.type === 'checkbox') params[key] = el.checked;
    else if (el.dataset.param === 'size' && el.value === 'source') params.size = 'source';
    else if (el.type === 'range' || el.type === 'number' || el.dataset.param === 'size' || el.dataset.param === 'alphaRef' || el.dataset.param === 'regionCount' || el.dataset.param === 'opacityRegion' || el.dataset.param === 'roadWidth') {
      params[key] = num(el.value, params[key]);
    } else params[key] = el.value;
  });
  params.opacityRegion = num(document.querySelector('[data-param="opacityRegion"]').value, -1);
  params.tileX = params.tileLeft || params.tileRight;
  params.tileY = params.tileUp || params.tileDown;
  params.heightWeights = [0.2, 0.45, 0.75, 1];
  params.normalWeights = [params.band0, params.band1, params.band2, params.band3].map((v) => num(v, 0.5));
  params.regionClass = [0, 1, 2, 3].map((i) => document.querySelector('[data-region-class="' + i + '"]').value);
  params.regionMetal = [0, 1, 2, 3].map((i) => num(document.querySelector('[data-region-metal="' + i + '"]').value, 0));
  const flatOf = (slot) => num(document.querySelector('[data-slot-flat="' + slot + '"]').value, 0.5);
  params.flatColor = hexColor(document.querySelector('[data-slot-color="albedo"]').value);
  const factorOf = (slot) => num(document.querySelector('[data-slot-factor="' + slot + '"]').value, 1);
  params.factors = { normal: factorOf('normal'), roughness: factorOf('roughness'), metallic: factorOf('metallic'), opacity: factorOf('opacity') };
  params.flatHeight = flatOf('height');
  params.flatAo = flatOf('ao');
  params.flatRough = flatOf('roughness');
  params.flatMetal = flatOf('metallic');
  params.flatOpacity = flatOf('opacity');
  const layout = String(params.layout).split('x').map((n) => num(n, 1));
  params.layoutPair = layout;
  params.light = [lightPointer.x, lightPointer.y];
  SLOTS.forEach(([name]) => {
    const mode = document.querySelector('[data-slot-mode="' + name + '"]').value;
    const key = name === 'albedo' ? 'albedoMode'
      : name === 'height' ? 'heightMode'
      : name === 'normal' ? 'normalMode'
      : name === 'roughness' ? 'roughMode'
      : name === 'metallic' ? 'metalMode'
      : name === 'ao' ? 'aoMode'
      : 'opacityMode';
    params[key] = mode;
    if (name === 'height') params.invertHeight = document.querySelector('[data-slot-invert="height"]').checked;
    if (name === 'ao') params.invertAo = document.querySelector('[data-slot-invert="ao"]').checked;
  });
  return params;
}

let whiteBalance = null;

const HISTORY_LIMIT = 30;
const HISTORY_CONTROL = '[data-param], [data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor], [data-region-class], [data-region-metal], #quad, #orm-order';
const undoStack = [];
const redoStack = [];
let restoring = false;
let held = null;

function controlNodes() {
  return document.querySelectorAll(HISTORY_CONTROL);
}

function readControls() {
  const values = [];
  controlNodes().forEach((el) => values.push(el.type === 'checkbox' ? el.checked : el.value));
  return values;
}

function writeControls(values) {
  controlNodes().forEach((el, i) => {
    if (el.type === 'checkbox') el.checked = values[i];
    else el.value = values[i];
  });
}

function takeSnapshot() {
  const names = {};
  document.querySelectorAll('[data-file-name]').forEach((el) => { names[el.dataset.fileName] = el.textContent; });
  return {
    original,
    slots: Object.assign({}, slotImages),
    whiteBalance: whiteBalance ? whiteBalance.slice() : null,
    lights: lights.map((light) => ({ image: light.image, az: light.az, el: light.el })),
    mask: document.getElementById('mask-file')._image || null,
    names,
    controls: readControls(),
  };
}

function sameSnapshot(a, b) {
  if (a.original !== b.original || a.mask !== b.mask) return false;
  if ((a.whiteBalance || []).join() !== (b.whiteBalance || []).join()) return false;
  if (a.controls.length !== b.controls.length) return false;
  for (let i = 0; i < a.controls.length; i++) if (a.controls[i] !== b.controls[i]) return false;
  const keys = Object.keys(a.slots);
  if (keys.length !== Object.keys(b.slots).length) return false;
  for (let i = 0; i < keys.length; i++) if (a.slots[keys[i]] !== b.slots[keys[i]]) return false;
  if (a.lights.length !== b.lights.length) return false;
  for (let i = 0; i < a.lights.length; i++) {
    if (a.lights[i].image !== b.lights[i].image || a.lights[i].az !== b.lights[i].az || a.lights[i].el !== b.lights[i].el) return false;
  }
  return true;
}

function remember() {
  if (restoring || held) return;
  held = takeSnapshot();
}

function commit() {
  if (restoring || !held) return;
  const now = takeSnapshot();
  if (sameSnapshot(held, now)) { held = null; return; }
  undoStack.push(held);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  held = null;
  redoStack.length = 0;
  syncHistoryButtons();
}

function clearThumbs() {
  Object.keys(stripThumbs).forEach((view) => stripThumbs[view].getContext('2d').clearRect(0, 0, THUMB, THUMB));
  Object.keys(slotThumbs).forEach((name) => slotThumbs[name].getContext('2d').clearRect(0, 0, THUMB, THUMB));
}

function applySnapshot(snap) {
  restoring = true;
  original = snap.original;
  Object.keys(slotImages).forEach((key) => delete slotImages[key]);
  Object.assign(slotImages, snap.slots);
  whiteBalance = snap.whiteBalance ? snap.whiteBalance.slice() : null;
  lights = snap.lights.map((light) => ({ image: light.image, az: light.az, el: light.el }));
  document.getElementById('mask-file')._image = snap.mask;
  writeControls(snap.controls);
  document.querySelectorAll('[data-file-name]').forEach((el) => {
    el.textContent = snap.names[el.dataset.fileName] || text('maps.choose');
  });
  SLOTS.forEach(([name]) => syncSlot(name));
  drawLights();
  restoring = false;
  if (!original) {
    document.getElementById('seam-note').textContent = '';
    drop.classList.remove('has-image');
    warningsEl.innerHTML = '';
    document.getElementById('scale-note').textContent = '';
    clearThumbs();
  }
  schedule();
}

function undo() {
  if (!undoStack.length) return;
  held = null;
  redoStack.push(takeSnapshot());
  applySnapshot(undoStack.pop());
  syncHistoryButtons();
}

function redo() {
  if (!redoStack.length) return;
  held = null;
  undoStack.push(takeSnapshot());
  applySnapshot(redoStack.pop());
  syncHistoryButtons();
}

function syncHistoryButtons() {
  document.getElementById('undo').disabled = undoStack.length === 0;
  document.getElementById('redo').disabled = redoStack.length === 0;
}

document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (!(event.ctrlKey || event.metaKey) || (key !== 'z' && key !== 'y')) return;
  const target = event.target;
  if (target && target.closest && target.closest('input, textarea')) {
    const kind = target.type;
    if (kind !== 'checkbox' && kind !== 'range' && kind !== 'file') return;
  }
  event.preventDefault();
  if (key === 'y' || event.shiftKey) redo();
  else undo();
});
document.body.addEventListener('pointerdown', (event) => {
  if (event.target.closest(HISTORY_CONTROL)) remember();
}, true);
document.body.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest && event.target.closest(HISTORY_CONTROL)) remember();
}, true);
document.body.addEventListener('change', (event) => {
  if (event.target.closest && event.target.closest(HISTORY_CONTROL)) commit();
});

const PRESET_KEY = 'mw-presets';
const PRESET_SKIP = new Set(['shape', 'layout', 'seamLines', 'split', 'name', 'crop', 'previewSize']);
const presetList = document.getElementById('preset-list');
const presetName = document.getElementById('preset-name');

function storedPresets() {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch (e) { /* ignore */ }
  return {};
}

function controlValue(el) {
  return el.type === 'checkbox' ? el.checked : el.value;
}

const SLOT_CONTROLS = '[data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor]';

function slotControlKey(el) {
  const d = el.dataset;
  if (d.slotMode != null) return 'mode:' + d.slotMode;
  if (d.slotChannel != null) return 'channel:' + d.slotChannel;
  if (d.slotInvert != null) return 'invert:' + d.slotInvert;
  if (d.slotColor != null) return 'color:' + d.slotColor;
  if (d.slotFactor != null) return 'factor:' + d.slotFactor;
  return 'flat:' + d.slotFlat;
}

function readPreset() {
  const values = {};
  document.querySelectorAll('[data-param]').forEach((el) => {
    if (!PRESET_SKIP.has(el.dataset.param)) values['p:' + el.dataset.param] = controlValue(el);
  });
  document.querySelectorAll(SLOT_CONTROLS).forEach((el) => {
    values['s:' + slotControlKey(el)] = controlValue(el);
  });
  document.querySelectorAll('[data-region-class], [data-region-metal]').forEach((el) => {
    const kind = el.dataset.regionClass != null ? 'class' : 'metal';
    values['r:' + kind + ':' + (el.dataset.regionClass || el.dataset.regionMetal)] = controlValue(el);
  });
  values.quad = document.getElementById('quad').value;
  values.orm = document.getElementById('orm-order').value;
  return values;
}

function writePreset(values) {
  document.querySelectorAll('[data-param]').forEach((el) => setControl(el, values['p:' + el.dataset.param]));
  document.querySelectorAll(SLOT_CONTROLS).forEach((el) => {
    setControl(el, values['s:' + slotControlKey(el)]);
  });
  document.querySelectorAll('[data-region-class], [data-region-metal]').forEach((el) => {
    const kind = el.dataset.regionClass != null ? 'class' : 'metal';
    setControl(el, values['r:' + kind + ':' + (el.dataset.regionClass || el.dataset.regionMetal)]);
  });
  if (values.quad != null) document.getElementById('quad').value = values.quad;
  if (values.orm != null) document.getElementById('orm-order').value = values.orm;
}

function setControl(el, value) {
  if (value == null) return;
  if (el.type === 'checkbox') el.checked = value === true || value === 'true';
  else el.value = value;
}

function fillPresetList(selected) {
  const presets = storedPresets();
  presetList.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = text('presets.none');
  presetList.appendChild(none);
  Object.keys(presets).sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    presetList.appendChild(option);
  });
  presetList.value = selected && presets[selected] ? selected : '';
  document.getElementById('preset-delete').disabled = !presetList.value;
}

function applyPreset(values) {
  remember();
  restoring = true;
  writePreset(values);
  restoring = false;
  SLOTS.forEach(([name]) => syncSlot(name));
  commit();
  schedule();
}

fillPresetList('');
presetList.addEventListener('change', () => {
  const values = storedPresets()[presetList.value];
  document.getElementById('preset-delete').disabled = !values;
  if (!values) return;
  presetName.value = presetList.value;
  applyPreset(values);
});
document.getElementById('preset-save').addEventListener('click', () => {
  const name = (presetName.value.trim() || presetList.value).slice(0, 40);
  if (!name) { presetName.focus(); return; }
  const presets = storedPresets();
  presets[name] = readPreset();
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) { /* ignore */ }
  presetName.value = name;
  fillPresetList(name);
});
document.getElementById('preset-delete').addEventListener('click', () => {
  if (!presetList.value) return;
  const presets = storedPresets();
  delete presets[presetList.value];
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) { /* ignore */ }
  presetName.value = '';
  fillPresetList('');
});

function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  el.style.setProperty('--fill', ((Number(el.value) - min) / Math.max(1e-6, max - min)) * 100 + '%');
}

function paintRanges() {
  document.querySelectorAll('input[type="range"]').forEach(paintRange);
}

document.addEventListener('input', (event) => {
  if (event.target.type === 'range') paintRange(event.target);
});

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(render, 40);
  paintRanges();
}

function canvasFromRGBA(rgba, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return c;
}

function imageDataOf(image) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

function extract(image, channel, invert) {
  const data = imageDataOf(image);
  const d = data.data;
  if (channel === 'rgb' && !invert) return image;
  for (let i = 0; i < d.length; i += 4) {
    if (channel === 'rgb') {
      d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
    } else {
      const idx = { r: 0, g: 1, b: 2, a: 3 }[channel];
      let v = channel === 'luma' ? 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] : d[i + idx];
      if (invert) v = 255 - v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

function isPow2(n) {
  return n >= 1 && (n & (n - 1)) === 0;
}

function potShape(w, h) {
  if (!isPow2(w) || !isPow2(h)) return null;
  const g = Math.min(w, h);
  return (w / g) + ':' + (h / g);
}

function shapeRatio(shape) {
  const parts = String(shape).split(':');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (parts.length !== 2 || !a || !b) return null;
  return { a, b };
}

function sizeFromRatio(max, ratio) {
  if (ratio.a >= ratio.b) return { w: max, h: Math.max(1, Math.round(max * ratio.b / ratio.a)) };
  return { w: Math.max(1, Math.round(max * ratio.a / ratio.b)), h: max };
}

function workingSize(image, max, shape) {
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

function orient(image, runs) {
  if (runs === 'left') {
    const data = imageDataOf(image);
    const turned = rotateBuffer(data.data, data.width, data.height, 1);
    return canvasFromRGBA(turned.rgba, turned.w, turned.h);
  }
  if (runs === 'right') {
    const data = imageDataOf(image);
    const turned = rotateBuffer(data.data, data.width, data.height, 3);
    return canvasFromRGBA(turned.rgba, turned.w, turned.h);
  }
  return image;
}

function paint(image, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(image, 0, 0, w, h);
  return c;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

const viewZoom = { zoom: 1, x: 0.5, y: 0.5 };
let previewRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function turnPreview(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cols = [0, 3, 6].map((i) => {
    const [x, y, z] = previewRot.slice(i, i + 3);
    const x1 = cy * x + sy * z;
    const z1 = -sy * x + cy * z;
    return [x1, cp * y - sp * z1, sp * y + cp * z1];
  });
  const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return v.map((c) => c / l); };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = unit(cols[0]);
  const d = dot(a, cols[1]);
  const b = unit(cols[1].map((c, i) => c - a[i] * d));
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  previewRot = [...a, ...b, ...c];
}
const zoomInput = document.getElementById('zoom');

function zoomMin() {
  return viewSelect.value === 'preview' ? 0.2 : 1;
}

function clampZoom() {
  const half = 0.5 / viewZoom.zoom;
  if (half >= 0.5) {
    viewZoom.x = 0.5;
    viewZoom.y = 0.5;
    return;
  }
  viewZoom.x = Math.min(1 - half, Math.max(half, viewZoom.x));
  viewZoom.y = Math.min(1 - half, Math.max(half, viewZoom.y));
}

function setZoom(next, anchor) {
  const zoom = Math.min(8, Math.max(zoomMin(), next));
  if (anchor) {
    const cx = (anchor.x - 0.5) / viewZoom.zoom + viewZoom.x;
    const cy = (anchor.y - 0.5) / viewZoom.zoom + viewZoom.y;
    viewZoom.zoom = zoom;
    viewZoom.x = cx - (anchor.x - 0.5) / zoom;
    viewZoom.y = cy - (anchor.y - 0.5) / zoom;
  } else viewZoom.zoom = zoom;
  clampZoom();
  if (document.activeElement !== zoomInput) zoomInput.value = String(viewZoom.zoom);
  paintRange(zoomInput);
  canvas.style.cursor = viewZoom.zoom > 1 ? 'grab' : '';
  presentCurrent();
}

function previewViewSize() {
  if (getComputedStyle(canvas).position !== 'absolute') return null;
  const rect = drop.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return [Math.max(2, Math.round(rect.width * dpr)), Math.max(2, Math.round(rect.height * dpr))];
}

function presentCurrent() {
  const params = readParams();
  engine.present(viewSelect.value, {
    split: params.split,
    layout: params.layoutPair,
    seamLines: params.seamLines,
    shape: params.shape,
    light: params.light,
    rot: previewRot,
    zoom: viewZoom.zoom,
    center: [viewZoom.x, viewZoom.y],
    viewSize: viewSelect.value === 'preview' ? previewViewSize() : null,
  });
}

new ResizeObserver(() => {
  if (viewSelect.value === 'preview' && original) presentCurrent();
}).observe(drop);

function drawThumbnails() {
  engine.thumbnails(stripThumbs);
  SLOTS.forEach(([name]) => {
    const c = slotThumbs[name];
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(stripThumbs[VIEW_OF_SLOT[name]], 0, 0);
  });
}

let lastRender = null;

function runEngine(size, tile, params) {
  if (engine.size().w !== size.w || engine.size().h !== size.h) engine.resize(size.w, size.h);
  engine.setSource(paint(tile.source, size.w, size.h));
  for (const [name] of SLOTS) {
    const mode = document.querySelector('[data-slot-mode="' + name + '"]').value;
    if (mode === 'load' && slotImages[name]) engine.setLoaded(mapName(name), paint(tile.slots[name], size.w, size.h));
    else engine.setLoaded(mapName(name), null);
  }
  const maskFile = document.getElementById('mask-file')._image;
  engine.setMask(maskFile ? paint(maskFile, size.w, size.h) : null);
  const warnings = engine.update(params) || [];
  if (engine.lost()) throw new Error('gpu-oom');
  return warnings;
}

function outputSize(sourceImage, tile, params) {
  const wanted = tile.pow2 && params.size === 'source' ? tile.pow2 : workingSize(sourceImage, params.size, params.pot);
  const limit = params.size === 'source' ? Math.min(SOURCE_CAP, gpuLimit()) : gpuLimit();
  return { wanted, size: capSize(wanted, limit) };
}

// Runs fn with the engine at the output size, then goes back to the preview size.
async function atOutputSize(fn) {
  if (!(await renderReady())) throw new Error(text('notes.gpuLost'));
  const tile = lastRender.tile;
  const params = readParams();
  const sourceImage = tile.source;
  const { wanted, size } = outputSize(sourceImage, tile, params);
  const same = engine.size().w === size.w && engine.size().h === size.h;
  let value;
  try {
    if (!same) runEngine(size, tile, params);
    value = fn(size);
  } catch (error) {
    if (error.message === 'gpu-oom') gpuFailed(Math.max(size.w, size.h));
    throw error;
  } finally {
    if (!same) await render();
  }
  const extra = [];
  if (params.size !== 'source') {
    const aspect = sourceImage.width / sourceImage.height;
    const targetAspect = size.w / size.h;
    if (targetAspect && Math.abs(aspect - targetAspect) / targetAspect > 0.15) extra.push(text('notes.stretch'));
  }
  if (size.w !== wanted.w || size.h !== wanted.h) {
    extra.push(text('notes.exportCap', { w: wanted.w, h: wanted.h, sw: size.w, sh: size.h }));
  }
  extra.forEach((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    warningsEl.appendChild(p);
  });
  return value;
}

async function render() {
  SLOTS.forEach(([name]) => syncSlot(name));
  syncViewButtons();
  if (!original) return;
  const params = readParams();
  const loadedNames = SLOTS.map(([name]) => name).filter((name) => slotImages[name] && document.querySelector('[data-slot-mode="' + name + '"]').value === 'load');
  const tile = tiledSet(params, loadedNames);
  const sourceImage = tile.source;
  const detected = potShape(sourceImage.width, sourceImage.height);
  const shapeSelect = document.querySelector('[data-param="pot"]');
  if (detected && !shapeSelect.querySelector('[value="' + detected + '"]')) {
    const option = document.createElement('option');
    option.value = detected;
    option.textContent = detected;
    shapeSelect.appendChild(option);
  }
  shapeSelect.querySelector('[value="auto"]').textContent = detected ? text('maps.autoDetected', { shape: detected }) : text('maps.auto');
  shapeSelect.disabled = params.size === 'source' && !detected;
  if (gpuLost) return false;
  const natural = tile.pow2 ? tile.pow2 : workingSize(sourceImage, 'source', params.pot);
  const asked = params.previewSize === 'full' ? Infinity : num(params.previewSize, 2048);
  const work = capSize(natural, Math.min(asked, gpuLimit()));
  const notes = [];
  if (oomInfo) notes.push(text('notes.gpuOom', oomInfo));
  if (tile.clipped.length) {
    notes.push(text('notes.tileMargin', { sides: tile.clipped.map((side) => text('notes.sideNames.' + side)).join(', ') }));
  }
  document.getElementById('seam-note').textContent = tile.scores
    ? text('notes.seam', { x: seamRate(tile.scores.x), y: seamRate(tile.scores.y) })
    : '';
  if (Math.max(work.w, work.h) + 0.5 < Math.min(Math.max(natural.w, natural.h), asked)) {
    notes.push(text('notes.gpuCap', { w: natural.w, h: natural.h, sw: work.w, sh: work.h }));
  }
  SLOTS.forEach(([name]) => {
    const stored = slotImages[name];
    if (stored && document.querySelector('[data-slot-mode="' + name + '"]').value === 'load'
      && (stored.width !== original.width || stored.height !== original.height)) {
      notes.push(text('notes.resampled', { name: name }));
    }
  });
  let warnings;
  try {
    warnings = runEngine(work, tile, params);
  } catch (error) {
    if (error.message !== 'gpu-oom') throw error;
    gpuFailed(Math.max(work.w, work.h));
    return false;
  }
  lastRender = { tile };
  drawThumbnails();
  presentCurrent();
  const length = textureLengthFor(params.roadWidth, work.w, work.h);
  const factorVars = { rough: params.factors.roughness.toFixed(2), metal: params.factors.metallic.toFixed(2) };
  document.getElementById('scale-note').textContent = params.profile === 'road' || !params.tileX
    ? text('notes.road', { width: params.roadWidth, length: length.toFixed(2), ...factorVars })
    : text('notes.factors', factorVars);
  warningsEl.innerHTML = '';
  notes.concat(warnings).forEach((line) => {
    const p = document.createElement('p');
    p.textContent = text('notes.' + line) || line;
    warningsEl.appendChild(p);
  });
  drop.classList.add('has-image');
  refreshEditor();
  return true;
}

const ids = new WeakMap();
let nextId = 1;
function idOf(obj) {
  if (!ids.has(obj)) ids.set(obj, nextId++);
  return ids.get(obj);
}

const orientCache = { key: '', image: null };
function orientedOriginal(runs) {
  const key = idOf(original) + runs;
  if (orientCache.key !== key) {
    orientCache.key = key;
    orientCache.image = orient(original, runs);
  }
  return orientCache.image;
}

const extractCache = new WeakMap();
function extractCached(image, channel, invert) {
  const key = channel + (invert ? '!' : '');
  const hit = extractCache.get(image);
  if (hit && hit.key === key) return hit.canvas;
  const canvas = extract(image, channel, invert);
  extractCache.set(image, { key, canvas });
  return canvas;
}

function tileSides(params) {
  const side = (name, on) => ({
    on: !!on,
    a: Math.min(params[name + 'A'], params[name + 'B']),
    b: Math.max(params[name + 'A'], params[name + 'B']),
  });
  return {
    left: side('left', params.tileLeft),
    right: side('right', params.tileRight),
    up: side('up', params.tileUp),
    down: side('down', params.tileDown),
  };
}

function frameRatio(shape, w, h) {
  if (shape === 'free') return null;
  if (shape === 'auto') {
    const k = Math.round(Math.log2(w / h));
    return k >= 0 ? { a: 2 ** k, b: 1 } : { a: 1, b: 2 ** -k };
  }
  return shapeRatio(shape);
}

function parseFrame(value) {
  const parts = String(value || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function currentFrame(params, w, h) {
  return parseFrame(params.crop) || autoFrame(w, h, frameRatio(params.cropShape, w, h), tileSides(params));
}

function tileActive(params) {
  return !!params.tileOn;
}

function tileOpts(params) {
  return { cut: params.tileBlend === 'cut', soft: params.tileSoft };
}

const tileCache = { key: '', result: null };
function tiledSet(params, slotNames) {
  const base = orientedOriginal(params.roadRuns);
  const sources = {};
  slotNames.forEach((name) => {
    const channel = document.querySelector('[data-slot-channel="' + name + '"]').value;
    const invert = document.querySelector('[data-slot-invert="' + name + '"]').checked;
    sources[name] = extractCached(slotImages[name], channel, invert);
  });
  if (!tileActive(params)) return { source: base, slots: sources, clipped: [], pow2: null, scores: null };
  const W = base.width;
  const H = base.height;
  const frame = currentFrame(params, W, H);
  const sides = tileSides(params);
  const opts = tileOpts(params);
  const key = [idOf(base)].concat(slotNames.map((name) => name + idOf(sources[name])), JSON.stringify([frame, sides, opts])).join('|');
  if (tileCache.key === key) return tileCache.result;
  const datas = [imageDataOf(base).data].concat(slotNames.map((name) => imageDataOf(paint(sources[name], W, H)).data));
  const out = tileImages(datas, W, H, frame, sides, opts);
  const ratio = frameRatio(params.cropShape, W, H);
  const result = {
    source: canvasFromRGBA(out.images[0], out.w, out.h),
    slots: {},
    clipped: out.clipped,
    pow2: ratio
      ? sizeFromRatio(2 ** Math.round(Math.log2(Math.max(out.w, out.h))), ratio)
      : { w: 2 ** Math.round(Math.log2(out.w)), h: 2 ** Math.round(Math.log2(out.h)) },
    scores: {
      x: params.tileX ? seamScore(out.images[0], out.w, out.h, 'x') : null,
      y: params.tileY ? seamScore(out.images[0], out.w, out.h, 'y') : null,
    },
  };
  slotNames.forEach((name, i) => { result.slots[name] = canvasFromRGBA(out.images[i + 1], out.w, out.h); });
  tileCache.key = key;
  tileCache.result = result;
  return result;
}

const cropInput = document.querySelector('[data-param="crop"]');
const PREVIEW_MAX = 1024;
const previewCache = { key: '', base: null, data: null, tileKey: '', tile: null };

function previewOf(full) {
  const key = idOf(full);
  if (previewCache.key !== key) {
    const scale = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height));
    const base = paint(full, Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale)));
    previewCache.key = key;
    previewCache.base = base;
    previewCache.data = imageDataOf(base).data;
  }
  return previewCache;
}

function tileTabActive() {
  const active = document.querySelector('[data-tab].is-active');
  return !!active && active.dataset.tab === 'tile';
}

function refreshEditor() {
  if (!original || !tileTabActive()) {
    editor.show(null);
    tileBar.hidden = true;
    return;
  }
  const tileSeg = tileBar.querySelector('.mw-seg');
  if (fixTools.open) {
    const preview = previewOf(original);
    tileBar.hidden = false;
    tileSeg.hidden = true;
    editor.show({
      base: preview.base,
      view: 'frame',
      fix: {
        mode: fixMode,
        angle: fixAngle(),
        quad: readQuad(),
        full: original,
        result: fixMode === 'quad' ? quadResult(preview) : null,
        labels: { angle: fixAngle().toFixed(1) + '°', result: text('tile.result') },
      },
    });
    return;
  }
  tileSeg.hidden = false;
  const params = readParams();
  const full = orientedOriginal(params.roadRuns);
  const preview = previewOf(full);
  const sides = tileSides(params);
  const frame = currentFrame(params, full.width, full.height);
  const opts = tileOpts(params);
  let tile = null;
  if (tileActive(params) && !framing) {
    const key = previewCache.key + JSON.stringify([frame, sides, opts]);
    if (previewCache.tileKey !== key) {
      const base = preview.base;
      const out = tileImages([preview.data], base.width, base.height, frame, sides, opts);
      previewCache.tileKey = key;
      previewCache.tile = canvasFromRGBA(out.images[0], out.w, out.h);
    }
    tile = previewCache.tile;
  }
  tileBar.hidden = false;
  tileBar.querySelectorAll('[data-tile-view]').forEach((el) => el.classList.toggle('is-active', el.dataset.tileView === tileView));
  editor.show({
    base: preview.base,
    frame,
    sides,
    ratio: frameRatio(params.cropShape, full.width, full.height),
    tile,
    view: tileView,
    cover: coverOn,
    seamLines: params.seamLines,
    labels: {
      beyond: { left: text('tile.beyondLeft'), right: text('tile.beyondRight'), up: text('tile.beyondUp'), down: text('tile.beyondDown') },
      size: text('tile.frameSize', { w: Math.round(frame.w * full.width), h: Math.round(frame.h * full.height) }),
    },
  });
}

const tileBar = document.getElementById('tile-bar');
let tileView = 'frame';
let framing = false;
function setTileView(view) {
  tileView = view;
  refreshEditor();
}
tileBar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tile-view]');
  if (button) setTileView(button.dataset.tileView);
});
const coverOn = { left: true, right: true, up: true, down: true };
function syncCoverEyes() {
  document.querySelectorAll('[data-cover]').forEach((input) => {
    input.checked = coverOn[input.dataset.cover] !== false;
    input.nextElementSibling.className = input.checked ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
  });
}
document.querySelector('.mw-fades').addEventListener('change', (event) => {
  const input = event.target.closest('[data-cover]');
  if (!input) return;
  coverOn[input.dataset.cover] = input.checked;
  syncCoverEyes();
  refreshEditor();
});

function seamRate(value) {
  if (value == null) return text('notes.seamOff');
  const rate = value < 0.04 ? 'seamGood' : value < 0.08 ? 'seamFaint' : 'seamBad';
  return text('notes.seamRate', { rate: text('notes.' + rate), value: value.toFixed(3) });
}

function frameString(frame) {
  return [frame.x, frame.y, frame.w, frame.h].map((v) => v.toFixed(5)).join(',');
}

const fixTools = document.getElementById('fix-tools');
const quadInput = document.getElementById('quad');
const angleInput = document.getElementById('fix-angle');
const IDENTITY_QUAD = [0, 0, 1, 0, 1, 1, 0, 1];
let fixMode = 'rotate';
const fixCache = { key: '', data: null, quad: '', result: null };

function readQuad() {
  const parts = quadInput.value.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  return parts.length >= 8 ? parts.slice(0, 8) : IDENTITY_QUAD.slice();
}

function fixAngle() {
  return Number(angleInput.value) || 0;
}

function setAngle(deg) {
  angleInput.value = String(deg);
  paintRange(angleInput);
  document.getElementById('fix-angle-value').textContent = fixAngle().toFixed(1) + '°';
}

function quadResult(preview) {
  if (fixCache.key !== preview.key) {
    const base = preview.base;
    const scale = Math.min(1, 320 / Math.max(base.width, base.height));
    fixCache.data = imageDataOf(paint(base, Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale))));
    fixCache.key = preview.key;
    fixCache.quad = '';
  }
  if (fixCache.quad !== quadInput.value) {
    const d = fixCache.data;
    fixCache.result = canvasFromRGBA(warpBuffer(d.data, d.width, d.height, homographyFromQuad(readQuad())), d.width, d.height);
    fixCache.quad = quadInput.value;
  }
  return fixCache.result;
}

function rotateFill(image, deg) {
  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d');
  const s = coverScale(c.width, c.height, deg);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(deg * Math.PI / 180);
  ctx.scale(s, s);
  ctx.drawImage(image, -c.width / 2, -c.height / 2);
  return c;
}

fixTools.addEventListener('toggle', refreshEditor);
document.getElementById('fix-mode').addEventListener('click', (event) => {
  const button = event.target.closest('[data-fix-mode]');
  if (!button) return;
  fixMode = button.dataset.fixMode;
  document.querySelectorAll('[data-fix-mode]').forEach((el) => el.classList.toggle('is-active', el === button));
  document.querySelectorAll('[data-fix]').forEach((el) => { el.hidden = el.dataset.fix !== fixMode; });
  refreshEditor();
});
angleInput.addEventListener('input', () => {
  setAngle(angleInput.value);
  refreshEditor();
});

const editor = createTileEditor(drop, {
  onStart() {
    remember();
    if (fixTools.open) return;
    if (!parseFrame(cropInput.value)) {
      const params = readParams();
      const full = orientedOriginal(params.roadRuns);
      cropInput.value = frameString(currentFrame(params, full.width, full.height));
    }
  },
  onFrame(frame) {
    framing = true;
    cropInput.value = frameString(frame);
    refreshEditor();
  },
  onFade(side, key, value) {
    document.querySelector('[data-param="' + side + key.toUpperCase() + '"]').value = value;
    refreshEditor();
  },
  onQuad(quad) {
    quadInput.value = quad.map((v) => v.toFixed(4)).join(',');
    refreshEditor();
  },
  onAngle(deg) {
    setAngle(deg);
    refreshEditor();
  },
  onEnd() {
    commit();
    if (fixTools.open) return;
    if (framing) {
      framing = false;
      refreshEditor();
    }
    schedule();
  },
  onView: setTileView,
});

document.querySelector('[data-param="cropShape"]').addEventListener('input', () => { cropInput.value = ''; });
document.getElementById('fit-frame').addEventListener('click', () => {
  remember();
  cropInput.value = '';
  commit();
  schedule();
  refreshEditor();
});

async function renderReady() {
  for (let i = 0; i < 4 && !gpuLost; i++) {
    if (await render()) return true;
  }
  return false;
}

const SOURCE_CAP = 4096;
let oomCap = Infinity;
let oomInfo = null;
let gpuLost = false;

function gpuLimit() {
  return Math.min(engine.maxSize(), oomCap);
}

function capSize(size, limit) {
  const long = Math.max(size.w, size.h);
  if (long <= limit) return size;
  const scale = limit / long;
  return { w: Math.max(1, Math.round(size.w * scale)), h: Math.max(1, Math.round(size.h * scale)) };
}

function gpuFailed(failedLong) {
  oomCap = Math.max(512, Math.pow(2, Math.floor(Math.log2(failedLong / 2))));
  oomInfo = { size: failedLong, cap: oomCap };
  if (!engine.lost()) {
    engine.release();
    schedule();
  }
}

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  gpuLost = true;
  if (oomCap === Infinity) {
    oomCap = Math.max(512, Math.pow(2, Math.floor(Math.log2(Math.max(engine.size().w, engine.size().h) / 2))));
    oomInfo = { size: Math.max(engine.size().w, engine.size().h), cap: oomCap };
  }
  warningsEl.textContent = text('notes.gpuLost');
});
canvas.addEventListener('webglcontextrestored', () => {
  engine = createEngine(canvas);
  gpuLost = false;
  schedule();
});

function mapName(slot) {
  if (slot === 'roughness') return 'roughness';
  if (slot === 'metallic') return 'metallic';
  if (slot === 'ao') return 'ao';
  return slot;
}

const slotImages = {};

viewSelect.addEventListener('change', () => showView(viewSelect.value));
document.body.addEventListener('input', (event) => {
  if (event.target.matches('[data-param="size"]')) {
    const shapeSelect = document.querySelector('[data-param="pot"]');
    const image = lastRender && lastRender.tile && lastRender.tile.source;
    const detected = image && potShape(image.width, image.height);
    shapeSelect.disabled = event.target.value === 'source' && !detected;
    return;
  }
  if (event.target.matches('[data-param], [data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor], [data-region-class], [data-region-metal]')) {
    schedule();
    refreshEditor();
  }
});
document.body.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-slot-file]');
  if (!input || !input.files[0]) return;
  const slot = input.dataset.slotFile;
  const image = await loadImage(input.files[0]);
  if (slot === 'albedo') {
    useImage(image, input.files[0]);
    return;
  }
  remember();
  slotImages[slot] = image;
  document.querySelector('[data-file-name="' + slot + '"]').textContent = input.files[0].name;
  document.querySelector('[data-slot-mode="' + slot + '"]').value = 'load';
  if (!original) {
    original = image;
    setNameFrom(input.files[0]);
  }
  commit();
  schedule();
});

const openFile = document.getElementById('open-file');
document.getElementById('open-photo').addEventListener('click', () => openFile.click());
drop.addEventListener('click', () => { if (!original) openFile.click(); });
openFile.addEventListener('change', async () => {
  const file = openFile.files[0];
  openFile.value = '';
  if (file) useImage(await loadImage(file), file);
});

function nameFromFile(file) {
  if (!file || !file.name || /^image\.\w+$/i.test(file.name)) return '';
  return classify(file.name).base.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '');
}

function setNameFrom(file) {
  const name = nameFromFile(file);
  if (name) document.querySelector('[data-param="name"]').value = name;
}

function useImage(image, file) {
  remember();
  SLOTS.forEach(([name]) => {
    if (name === 'albedo') return;
    delete slotImages[name];
    setSlotMode(name, 'generate');
    document.querySelector('[data-file-name="' + name + '"]').textContent = text('maps.choose');
  });
  original = image;
  slotImages.albedo = image;
  setSlotMode('albedo', 'load');
  document.querySelector('[data-file-name="albedo"]').textContent = file && file.name ? file.name : text('maps.choose');
  cropInput.value = '';
  setNameFrom(file);
  commit();
  schedule();
}

drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('is-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', async (event) => {
  event.preventDefault();
  drop.classList.remove('is-over');
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) useImage(await loadImage(file), file);
});
window.addEventListener('paste', async (event) => {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      useImage(await loadImage(file), file);
      break;
    }
  }
});

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.preset;
    const side = (name, on) => { document.querySelector('[data-param="tile' + name + '"]').checked = on; };
    const profile = document.querySelector('[data-param="profile"]');
    const edge = document.querySelector('[data-param="opacityEdge"]');
    remember();
    document.querySelector('[data-param="tileOn"]').checked = true;
    side('Right', false);
    side('Down', false);
    side('Left', kind === 'surface');
    side('Up', true);
    profile.value = kind === 'surface' ? 'level' : 'road';
    edge.value = kind === 'surface' ? 0 : 0.18;
    cropInput.value = '';
    commit();
    schedule();
    refreshEditor();
  });
});

document.getElementById('pick-white').addEventListener('click', () => { pickWhite = true; });
document.getElementById('clear-white').addEventListener('click', () => { remember(); whiteBalance = null; commit(); schedule(); });
let panFrom = null;
canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1) event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  panFrom = { x: event.clientX, y: event.clientY };
  if (viewZoom.zoom > 1 || viewSelect.value === 'preview') canvas.style.cursor = 'grabbing';
});
function imagePoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

function viewUv(event) {
  const point = imagePoint(event);
  return { x: point.x, y: 1 - point.y };
}
function fittedSize() {
  const rect = canvas.getBoundingClientRect();
  const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  return { w: canvas.width * fit, h: canvas.height * fit };
}
canvas.addEventListener('pointermove', (event) => {
  if (!event.buttons || pickWhite || !panFrom) return;
  const preview = viewSelect.value === 'preview';
  const lightDrag = event.buttons === 2 || event.shiftKey;
  const dx = event.clientX - panFrom.x;
  const dy = event.clientY - panFrom.y;
  if (preview && event.buttons === 1 && !event.shiftKey) {
    turnPreview(dx * 0.01, dy * 0.01);
    panFrom = { x: event.clientX, y: event.clientY };
    presentCurrent();
    return;
  }
  if (viewZoom.zoom > 1 && (preview ? event.buttons === 4 : event.buttons === 1)) {
    const fit = fittedSize();
    viewZoom.x -= dx / fit.w / viewZoom.zoom;
    viewZoom.y += dy / fit.h / viewZoom.zoom;
    panFrom = { x: event.clientX, y: event.clientY };
    clampZoom();
    presentCurrent();
    return;
  }
  if (preview ? !lightDrag : event.buttons !== 1) return;
  const point = imagePoint(event);
  lightPointer.x = point.x * 2 - 1;
  lightPointer.y = 1 - point.y * 2;
  presentCurrent();
});
function endPan() {
  panFrom = null;
  canvas.style.cursor = viewZoom.zoom > 1 ? 'grab' : '';
}
canvas.addEventListener('pointerup', endPan);
canvas.addEventListener('pointercancel', endPan);
canvas.addEventListener('dblclick', () => {
  if (!original) return;
  if (viewSelect.value === 'preview') {
    previewRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  if (viewZoom.zoom > 1) setZoom(1);
  else presentCurrent();
});
canvas.addEventListener('contextmenu', (event) => { if (viewSelect.value === 'preview') event.preventDefault(); });
drop.addEventListener('wheel', (event) => {
  const tileEdit = drop.querySelector('.mw-tile-edit');
  if (!original || (tileEdit && !tileEdit.hidden)) return;
  event.preventDefault();
  setZoom(viewZoom.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), viewUv(event));
}, { passive: false });
zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
canvas.addEventListener('click', (event) => {
  if (!pickWhite) return;
  pickWhite = false;
  const uv = viewUv(event);
  const point = {
    x: (uv.x - 0.5) / viewZoom.zoom + viewZoom.x,
    y: 1 - ((uv.y - 0.5) / viewZoom.zoom + viewZoom.y),
  };
  const map = engine.readMap('source');
  if (!map) return;
  const x = Math.max(0, Math.min(map.w - 1, Math.floor(point.x * map.w)));
  const y = Math.max(0, Math.min(map.h - 1, Math.floor(point.y * map.h)));
  const i = (y * map.w + x) * 4;
  const r = map.rgba[i] / 255, g = map.rgba[i + 1] / 255, b = map.rgba[i + 2] / 255;
  const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  remember();
  whiteBalance = [yv / Math.max(0.02, r), yv / Math.max(0.02, g), yv / Math.max(0.02, b)];
  commit();
  schedule();
});

document.getElementById('mask-file').addEventListener('change', async (event) => {
  remember();
  event.target._image = event.target.files[0] ? await loadImage(event.target.files[0]) : null;
  commit();
  schedule();
});

document.getElementById('straighten').addEventListener('click', () => {
  if (!original) return;
  const data = imageDataOf(previewOf(original).base);
  const turn = 90 - dominantAngle(data.data, data.width, data.height);
  setAngle(Math.round(((((turn + 45) % 90) + 90) % 90 - 45) * 10) / 10);
  refreshEditor();
});

document.getElementById('fix-angle-reset').addEventListener('click', () => {
  setAngle(0);
  refreshEditor();
});

document.getElementById('apply-rotate').addEventListener('click', () => {
  if (!original || !fixAngle()) return;
  remember();
  original = rotateFill(original, fixAngle());
  setAngle(0);
  commit();
  schedule();
  refreshEditor();
});

document.getElementById('quad-reset').addEventListener('click', () => {
  remember();
  quadInput.value = IDENTITY_QUAD.join(',');
  commit();
  refreshEditor();
});

function showRepeat() {
  const note = document.getElementById('repeat-note');
  if (!repeatInfo) { note.textContent = text('notes.repeatNone'); return; }
  note.textContent = text('notes.repeat', { x: repeatInfo.periodX, y: repeatInfo.periodY, w: repeatInfo.cropW, h: repeatInfo.cropH });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text('tile.useCrop');
  button.addEventListener('click', () => {
    remember();
    const w = repeatInfo.cropW / repeatSize.w;
    const h = repeatInfo.cropH / repeatSize.h;
    document.querySelector('[data-param="cropShape"]').value = 'free';
    document.querySelector('[data-param="tileOn"]').checked = true;
    cropInput.value = frameString({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
    fixTools.open = false;
    commit();
    schedule();
    refreshEditor();
  });
  note.appendChild(button);
}

document.getElementById('find-repeat').addEventListener('click', () => {
  if (!original) return;
  const data = imageDataOf(orient(original, readParams().roadRuns));
  repeatSize = { w: data.width, h: data.height };
  repeatInfo = findRepeat(data.data, data.width, data.height);
  showRepeat();
});

document.getElementById('rectify').addEventListener('click', () => {
  if (!original) return;
  const quad = readQuad();
  if (quad.every((v, i) => v === IDENTITY_QUAD[i])) return;
  remember();
  const data = imageDataOf(original);
  const warped = warpBuffer(data.data, data.width, data.height, homographyFromQuad(quad));
  original = canvasFromRGBA(warped, data.width, data.height);
  quadInput.value = IDENTITY_QUAD.join(',');
  commit();
  schedule();
  refreshEditor();
});

document.getElementById('add-light').addEventListener('click', () => document.getElementById('light-file').click());
document.getElementById('light-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  remember();
  const image = await loadImage(file);
  lights.push({ image, az: lights.length * 90, el: 45 });
  commit();
  drawLights();
});

function drawLights() {
  const host = document.getElementById('lights');
  host.innerHTML = '';
  lights.forEach((light, index) => {
    const row = document.createElement('div');
    row.className = 'mw-light';
    row.innerHTML = '<span>' + text('maps.light', { n: index + 1 }) + '</span>';
    const az = document.createElement('input');
    az.type = 'number';
    az.value = light.az;
    az.title = text('maps.azimuth');
    az.addEventListener('focus', () => remember());
    az.addEventListener('input', () => { light.az = num(az.value, 0); });
    az.addEventListener('change', () => { light.az = num(az.value, 0); commit(); });
    const el = document.createElement('input');
    el.type = 'number';
    el.value = light.el;
    el.title = text('maps.elevation');
    el.addEventListener('focus', () => remember());
    el.addEventListener('input', () => { light.el = num(el.value, 45); });
    el.addEventListener('change', () => { light.el = num(el.value, 45); commit(); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = text('maps.remove');
    remove.addEventListener('click', () => { remember(); lights.splice(index, 1); commit(); drawLights(); });
    row.appendChild(az);
    row.appendChild(el);
    row.appendChild(remove);
    host.appendChild(row);
  });
}

document.getElementById('solve-lights').addEventListener('click', () => {
  if (lights.length < 3) {
    warningsEl.textContent = text('notes.lights');
    return;
  }
  remember();
  const w = 256;
  const h = 256;
  const images = lights.map((light) => {
    const c = paint(light.image, w, h);
    return c.getContext('2d').getImageData(0, 0, w, h).data;
  });
  const solved = solveLights(images, lights.map((light) => ({ az: light.az, el: light.el })), w, h);
  original = canvasFromRGBA(solved.albedo, w, h);
  slotImages.normal = canvasFromRGBA(solved.normal, w, h);
  document.querySelector('[data-slot-mode="normal"]').value = 'load';
  document.querySelector('[data-slot-mode="albedo"]').value = 'load';
  slotImages.albedo = original;
  commit();
  schedule();
});

document.getElementById('orm-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  remember();
  const image = await loadImage(file);
  const order = document.getElementById('orm-order').value;
  const map = order === 'arm'
    ? { roughness: 'r', metallic: 'g', ao: 'b' }
    : { ao: 'r', roughness: 'g', metallic: 'b' };
  Object.keys(map).forEach((slot) => {
    slotImages[slot] = extract(image, map[slot], false);
    document.querySelector('[data-slot-mode="' + slot + '"]').value = 'load';
    document.querySelector('[data-slot-channel="' + slot + '"]').value = 'r';
  });
  if (!original) original = image;
  commit();
  schedule();
});

async function filesForCurrent(subfolder) {
  const params = readParams();
  const prefix = subfolder ? subfolder + '/' : '';
  const names = [
    ['albedo', params.name + '_b.color.png'],
    ['normal', params.name + '_nm.normal.png'],
    ['rough', params.name + '_r.dataR.png'],
    ['metal', params.name + '_m.dataR.png'],
    ['ao', params.name + '_ao.dataR.png'],
  ];
  const shapedOpacity = params.opacityEdge > 0 || params.opacityPatch > 0 || params.opacityCrack > 0 || params.opacityRegion >= 0;
  if (params.profile === 'road' || params.opacityMode === 'load' || shapedOpacity) {
    names.push(['opacity', params.name + '_o.dataR.png']);
  }
  const { size, images } = await atOutputSize((at) => ({
    size: at,
    images: names.map(([key]) => engine.readMap(key)),
  }));
  const files = [];
  for (let i = 0; i < names.length; i++) {
    files.push({ name: prefix + names[i][1], data: await pngBytes(images[i].rgba, images[i].w, images[i].h) });
  }
  const json = JSON.stringify(materialDocument({
    name: params.name,
    folder: params.folder,
    profile: params.profile,
    annotation: params.annotation,
    alphaRef: params.alphaRef,
    roughnessFactor: params.factors.roughness,
    metallicFactor: params.factors.metallic,
    opacityFactor: params.factors.opacity,
    normalMapStrength: params.factors.normal,
    baseColorFactor: params.albedoMode === 'flat' ? null : params.flatColor,
    includeOpacity: names.some((entry) => entry[0] === 'opacity'),
  }), null, 2);
  files.push({ name: prefix + 'main.materials.json', data: new TextEncoder().encode(json) });
  if (params.profile === 'road') {
    const length = textureLengthFor(params.roadWidth, size.w, size.h);
    files.push({
      name: prefix + 'textureLength.txt',
      data: new TextEncoder().encode(text('notes.lengthFile', { length: length.toFixed(3) })),
    });
  }
  return files;
}

const SAVE = {
  albedo: ['albedo', '_b.color.png', 'Base color'],
  height: ['height', '_h.dataR.png', 'Height'],
  normal: ['normal', '_nm.normal.png', 'Normal'],
  roughness: ['rough', '_r.dataR.png', 'Roughness'],
  metallic: ['metal', '_m.dataR.png', 'Metallic'],
  ao: ['ao', '_ao.dataR.png', 'AO'],
  opacity: ['opacity', '_o.dataR.png', 'Opacity'],
};
const saveHost = document.getElementById('save-maps');
Object.keys(SAVE).forEach((slot) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.save = slot;
  button.innerHTML = '<i class="fa-solid fa-download"></i> <span data-copy="slots.' + slot + '">' + text('slots.' + slot) + '</span>';
  saveHost.appendChild(button);
});
document.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-save]');
  if (!button || !original) return;
  const [key, suffix] = SAVE[button.dataset.save];
  const image = await atOutputSize(() => engine.readMap(key)).catch(() => null);
  if (!image) return;
  downloadBytes(await pngBytes(image.rgba, image.w, image.h), readParams().name + suffix, 'image/png');
});

document.getElementById('download').addEventListener('click', async () => {
  if (!original) return;
  const files = await filesForCurrent('');
  downloadBytes(zipStore(files), readParams().name + '.zip', 'application/zip');
});

function classify(filename) {
  const stem = filename.split('/').pop().replace(/\.[^.]+$/, '');
  const rules = [
    [/_b\.color$/i, 'albedo'],
    [/_nm\.normal$/i, 'normal'],
    [/_r\.dataR?$/i, 'roughness'],
    [/_m\.dataR?$/i, 'metallic'],
    [/_ao\.dataR?$/i, 'ao'],
    [/_o\.dataR?$/i, 'opacity'],
    [/(basecolor|albedo|diffuse|_color)$/i, 'albedo'],
    [/(normal|nrm|_normal)$/i, 'normal'],
    [/(height|displacement|disp)$/i, 'height'],
    [/(roughness|rough)$/i, 'roughness'],
    [/(metallic|metalness)$/i, 'metallic'],
    [/(_ao|occlusion)$/i, 'ao'],
    [/(opacity|alpha)$/i, 'opacity'],
  ];
  for (const [re, slot] of rules) {
    if (re.test(stem)) return { slot, base: stem.replace(re, '').replace(/[_\-\s]+$/, '') || stem };
  }
  return { slot: 'source', base: stem };
}

function groupFiles(fileList) {
  const groups = new Map();
  Array.from(fileList).forEach((file) => {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) return;
    const info = classify(file.name);
    const key = info.slot === 'source' ? info.base : info.base;
    if (!groups.has(key)) groups.set(key, { base: key || file.name, files: {} });
    const group = groups.get(key);
    if (info.slot === 'source') group.files.albedo = file;
    else group.files[info.slot] = file;
    if (!group.files.albedo && info.slot === 'source') group.files.albedo = file;
  });
  return Array.from(groups.values()).filter((group) => group.files.albedo || group.files.source);
}

document.getElementById('batch-folder').addEventListener('change', (event) => {
  const list = document.getElementById('batch-list');
  list.innerHTML = '';
  groupFiles(event.target.files).forEach((group) => {
    const li = document.createElement('li');
    li.textContent = text('notes.batchLine', { name: group.base, files: Object.keys(group.files).join(', ') });
    list.appendChild(li);
  });
});

async function runGroups(files, writer) {
  const groups = groupFiles(files);
  const list = document.getElementById('batch-list');
  list.innerHTML = '';
  const all = [];
  for (const group of groups) {
    const li = document.createElement('li');
    li.textContent = text('notes.batchWork', { name: group.base });
    list.appendChild(li);
    try {
      const colorFile = group.files.albedo;
      if (!colorFile) throw new Error('no color image');
      original = await loadImage(colorFile);
      document.querySelector('[data-param="name"]').value = group.base.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+/, '') || 'm_material';
      for (const [name] of SLOTS) {
        slotImages[name] = null;
        document.querySelector('[data-slot-mode="' + name + '"]').value = 'generate';
      }
      slotImages.albedo = original;
      if (group.files.normal) {
        slotImages.normal = await loadImage(group.files.normal);
        document.querySelector('[data-slot-mode="normal"]').value = 'load';
        document.querySelector('[data-param="addDetail"]').checked = true;
      }
      for (const slot of ['height', 'roughness', 'metallic', 'ao', 'opacity']) {
        if (group.files[slot]) {
          slotImages[slot] = await loadImage(group.files[slot]);
          document.querySelector('[data-slot-mode="' + slot + '"]').value = 'load';
        }
      }
      const produced = await filesForCurrent(group.base);
      if (writer) await writer(group.base, produced);
      else all.push(...produced);
      li.textContent = text('notes.batchDone', { name: group.base });
    } catch (error) {
      li.textContent = text('notes.batchFail', { name: group.base });
    }
  }
  return all;
}

document.getElementById('run-batch').addEventListener('click', async () => {
  const input = document.getElementById('batch-folder');
  if (!input.files.length) return;
  const all = await runGroups(input.files, null);
  if (all.length) downloadBytes(zipStore(all), 'material-wizard-batch.zip', 'application/zip');
});

document.getElementById('write-folder').addEventListener('click', async () => {
  const input = document.getElementById('batch-folder');
  if (!input.files.length || !window.showDirectoryPicker) {
    document.getElementById('run-batch').click();
    return;
  }
  const dir = await window.showDirectoryPicker();
  await runGroups(input.files, async (name, produced) => {
    const sub = await dir.getDirectoryHandle(name, { create: true });
    for (const file of produced) {
      const leaf = file.name.split('/').pop();
      const handle = await sub.getFileHandle(leaf, { create: true });
      const stream = await handle.createWritable();
      await stream.write(file.data);
      await stream.close();
    }
  });
});

engine.resize(1024, 1024);
