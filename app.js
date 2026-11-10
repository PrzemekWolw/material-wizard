import { createEngine, CLASSES } from './pbr.js';
import { pngBytes, grayPngBytes, zipStore, downloadBytes, materialDocument, textureLengthFor, readProject } from './export.js';
import { VERSION, versionNewer } from './version.js';
import {
  findRepeat, autoFrame, tileImages, rotateBuffer, solveLights,
  dominantAngle, homographyFromQuad, warpBuffer, seamScore,
} from './tile.js';
import { createTileEditor, coverScale } from './tile-editor.js';

const LANGUAGES = [
  ['en_US', 'English'], ['pl_PL', 'Polski'], ['es_ES', 'Español'], ['de_DE', 'Deutsch'], ['it_IT', 'Italiano'],
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

async function fetchTranslation(code) {
  try {
    return await (await fetch(new URL('./locales/' + code + '/main.translation.json', import.meta.url))).json();
  } catch (e) {
    return {};
  }
}

const english = await fetchTranslation(LANGUAGES[0][0]);
let translation = language === LANGUAGES[0][0] ? english : await fetchTranslation(language);
document.documentElement.lang = language.slice(0, 2);

function text(key, vars) {
  let value = translation[key];
  if (typeof value !== 'string' || !value) value = english[key];
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
    const vars = node.dataset.labelSlot ? { name: text('ui.materialWizard.slots.' + node.dataset.labelSlot) } : null;
    node.setAttribute('aria-label', text(node.dataset.label, vars));
  });
  root.querySelectorAll('[data-placeholder]').forEach((node) => {
    node.placeholder = text(node.dataset.placeholder);
  });
}

fillCopy(document);
document.title = text('ui.materialWizard.pageTitle');
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
  const next = code === LANGUAGES[0][0] ? english : await fetchTranslation(code);
  if (token !== languageToken) return;
  language = code;
  translation = next;
  document.documentElement.lang = language.slice(0, 2);
  fillCopy(document);
  document.title = text('ui.materialWizard.pageTitle');
  refreshLanguage();
}

function refreshLanguage() {
  document.querySelectorAll('[data-file-name]').forEach((el) => {
    if (!slotImages[el.dataset.fileName]) el.textContent = text('ui.materialWizard.maps.choose');
  });
  fillPresetList(presetList.value);
  if (repeatInfo) showRepeat();
  drawLights();
  refreshEditor();
  if (original && !gpuLost) schedule();
  syncHdrNote();
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
  normal: { copy: 'ui.materialWizard.maps.strength', max: 2 },
  roughness: { copy: 'ui.materialWizard.maps.factor', max: 1 },
  metallic: { copy: 'ui.materialWizard.maps.factor', max: 1 },
  opacity: { copy: 'ui.materialWizard.maps.factor', max: 1 },
};

const canvas = document.getElementById('view');
let engine = createEngine(canvas);
const drop = document.getElementById('drop');
const warningsEl = document.getElementById('warnings');
let original = null;
let photoBytes = null;
let photoName = null;
let sessionNote = '';
let picker = null;
let repeatInfo = null;
let repeatSize = null;
let lights = [];
let lightQueue = null;
let timer = 0;
let tileIdle = 0;
const sunAngle = { az: 25, el: 30 };
const sunDial = document.getElementById('sun-dial');
const DIAL = 128;
const SUN_EL_MIN = -45;
const HORIZON_R = 0.78;
let dialDragging = false;

function setSun(az, el) {
  sunAngle.az = ((az % 360) + 360) % 360;
  sunAngle.el = Math.max(SUN_EL_MIN, Math.min(90, el));
  drawSunDial();
  presentCurrent();
}

function dialRadius(el, R) {
  const h = R * HORIZON_R;
  if (el >= 0) return h * (1 - el / 90);
  return h + (R - h) * (el / SUN_EL_MIN);
}

// Seen from above: the centre is overhead, the bright ring is the horizon, the camera sits at the bottom.
function drawSunDial() {
  if (sunDial.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(DIAL * dpr);
  if (sunDial.width !== px) { sunDial.width = px; sunDial.height = px; }
  const ctx = sunDial.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, DIAL, DIAL);
  const c = DIAL / 2;
  const R = c - 14;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f15a22';
  const hR = R * HORIZON_R;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath();
  ctx.arc(c, c, c - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.arc(c, c, hR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  [2 / 3, 1 / 3].forEach((k) => {
    ctx.beginPath();
    ctx.arc(c, c, hR * k, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.beginPath();
  ctx.moveTo(c - hR, c); ctx.lineTo(c + hR, c);
  ctx.moveTo(c, c - hR); ctx.lineTo(c, c + hR);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(c, c, hR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  ctx.moveTo(c, c + R - 10);
  ctx.lineTo(c - 7, c + R + 6);
  ctx.lineTo(c + 7, c + R + 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(c - 4, c - 4, 8, 8);
  const az = sunAngle.az * Math.PI / 180;
  const r = dialRadius(sunAngle.el, R);
  const sx = c + r * Math.sin(az);
  const sy = c + r * Math.cos(az);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c, c); ctx.lineTo(sx, sy);
  ctx.stroke();
  ctx.fillStyle = '#ffd34d';
  ctx.beginPath();
  ctx.arc(sx, sy, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(Math.round(sunAngle.az) + '° / ' + Math.round(sunAngle.el) + '°', c, 11);
}

function dialSun(event) {
  const rect = sunDial.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  const R = rect.width / 2 - 14 * rect.width / DIAL;
  const h = R * HORIZON_R;
  const d = Math.hypot(x, y);
  const el = d <= h ? 90 * (1 - d / h) : SUN_EL_MIN * Math.min(1, (d - h) / Math.max(1, R - h));
  setSun(Math.atan2(x, y) * 180 / Math.PI, el);
}

sunDial.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  event.stopPropagation();
  sunDial.setPointerCapture(event.pointerId);
  dialDragging = true;
  dialSun(event);
});
sunDial.addEventListener('pointermove', (event) => { if (dialDragging) dialSun(event); });
const endDial = () => { dialDragging = false; };
sunDial.addEventListener('pointerup', endDial);
sunDial.addEventListener('pointercancel', endDial);
sunDial.addEventListener('dblclick', (event) => { event.stopPropagation(); setSun(25, 30); });
sunDial.addEventListener('wheel', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setSun(sunAngle.az, sunAngle.el + (event.deltaY < 0 ? 3 : -3));
}, { passive: false });

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
  span.dataset.copy = 'ui.materialWizard.strip.' + view;
  span.textContent = text('ui.materialWizard.strip.' + view);
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
  zoomInput.dataset.title = view === 'preview' ? 'ui.materialWizard.preview.zoomTip' : 'ui.materialWizard.zoomTip';
  zoomInput.title = text(zoomInput.dataset.title);
  const tip = document.getElementById('lit-tip');
  if (tip) tip.hidden = view !== 'preview';
  sunDial.hidden = view !== 'preview';
  drawSunDial();
  syncViewButtons();
  if (viewZoom.zoom < zoomMin()) setZoom(viewZoom.zoom);
  else {
    clampZoom();
    presentCurrent();
  }
}

function syncViewButtons() {
  document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('is-active', el.dataset.view === viewSelect.value));
}

const slotHost = document.getElementById('slots');
SLOTS.forEach(([name, flat]) => {
  const label = text('ui.materialWizard.slots.' + name);
  const modes = name === 'albedo'
    ? [['load', 'ui.materialWizard.modes.image'], ['flat', 'ui.materialWizard.modes.flat']]
    : [['generate', 'ui.materialWizard.modes.generate'], ['load', 'ui.materialWizard.modes.load'], ['flat', 'ui.materialWizard.modes.flat']];
  const box = document.createElement('div');
  box.className = 'mw-slot';
  box.dataset.slot = name;
  box.innerHTML = '<button type="button" class="mw-thumb mw-slot-thumb" data-view="' + VIEW_OF_SLOT[name] + '" data-title="ui.materialWizard.maps.show" title="' + text('ui.materialWizard.maps.show') + '"></button>'
    + '<div class="mw-slot-body">'
    + '<div class="mw-slot-head"><h3 data-copy="ui.materialWizard.slots.' + name + '">' + label + '</h3>'
    + '<button type="button" class="mw-save mw-round" data-save="' + name + '" data-title="ui.materialWizard.maps.save" data-label="ui.materialWizard.maps.saveAs" data-label-slot="' + name + '" title="' + text('ui.materialWizard.maps.save') + '" aria-label="' + text('ui.materialWizard.maps.saveAs', { name: label }) + '"><i class="fa-solid fa-download"></i></button></div>'
    + '<div class="mw-seg" data-seg="' + name + '">'
    + modes.map(([mode, key]) => '<button type="button" data-mode="' + mode + '" data-copy="' + key + '">' + text(key) + '</button>').join('')
    + '</div>'
    + '<select class="mw-hidden" data-slot-mode="' + name + '">'
    + modes.map(([mode, key]) => '<option value="' + mode + '" data-copy="' + key + '">' + text(key) + '</option>').join('')
    + '</select>'
    + '<div class="mw-row" data-when="load">'
    + '<label class="mw-file"><input type="file" data-slot-file="' + name + '" accept="image/*"><span data-file-name="' + name + '">' + text('ui.materialWizard.maps.choose') + '</span></label>'
    + (name === 'albedo' ? ''
      : '<select data-slot-channel="' + name + '" data-title="ui.materialWizard.maps.channel" title="' + text('ui.materialWizard.maps.channel') + '"><option value="rgb">RGB</option><option value="luma">luma</option><option value="r"' + (COLOR_SLOTS.includes(name) ? '' : ' selected') + '>R</option><option value="g">G</option><option value="b">B</option><option value="a">A</option></select>'
        + '<label class="mw-check"><input type="checkbox" data-slot-invert="' + name + '"> <span data-copy="ui.materialWizard.maps.invert">' + text('ui.materialWizard.maps.invert') + '</span></label>')
    + '</div>'
    + (name === 'albedo'
      ? '<label class="mw-field" data-title="ui.materialWizard.maps.colorTip" title="' + text('ui.materialWizard.maps.colorTip') + '"><span data-copy="ui.materialWizard.maps.color">' + text('ui.materialWizard.maps.color') + '</span>'
        + '<input type="color" data-slot-color="albedo" value="#ffffff"></label>'
      : '<label class="mw-field" data-when="flat"><span data-copy="ui.materialWizard.maps.value">' + text('ui.materialWizard.maps.value') + '</span>'
        + '<input type="range" data-slot-flat="' + name + '" min="0" max="1" step="0.01" value="' + flat + '"></label>')
    + (FACTOR_SLOTS[name]
      ? '<label class="mw-field" data-title="ui.materialWizard.maps.factorTip" title="' + text('ui.materialWizard.maps.factorTip') + '"><span data-copy="' + FACTOR_SLOTS[name].copy + '">' + text(FACTOR_SLOTS[name].copy) + '</span>'
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
  document.querySelectorAll('[data-load-detail="' + name + '"]').forEach((el) => { el.hidden = mode !== 'load'; });
}
SLOTS.forEach(([name]) => syncSlot(name));
const orm = document.createElement('div');
orm.className = 'mw-actions mw-orm';
orm.innerHTML = '<label class="mw-text"><span data-copy="ui.materialWizard.maps.unpack">' + text('ui.materialWizard.maps.unpack') + '</span> <input type="file" id="orm-file" accept="image/*"></label>'
  + '<select id="orm-order"><option value="orm" data-copy="ui.materialWizard.maps.orm">' + text('ui.materialWizard.maps.orm') + '</option><option value="arm" data-copy="ui.materialWizard.maps.rma">' + text('ui.materialWizard.maps.rma') + '</option></select>';
slotHost.appendChild(orm);

const ZONE_COUNT = 6;
const zoneHost = document.getElementById('zones');

function zoneEl(i, field) {
  return zoneHost.querySelector('[data-zone="' + i + '"][data-zone-field="' + field + '"]');
}

function zoneSlider(i, field, copy, min, max, value, tip) {
  return '<label class="mw-field"' + (tip ? ' data-title="' + tip + '"' : '') + '><span data-copy="' + copy + '"></span>'
    + '<input type="range" data-zone="' + i + '" data-zone-field="' + field + '" min="' + min + '" max="' + max + '" step="0.01" value="' + value + '"></label>';
}

function zoneClassSelect(i) {
  return '<label class="mw-field"><span data-copy="ui.materialWizard.surface.material"></span><select data-zone="' + i + '" data-zone-field="class">'
    + Object.keys(CLASSES).map((name) => '<option value="' + name + '" data-copy="ui.materialWizard.classes.' + name + '"></option>').join('')
    + '</select></label>';
}

for (let i = 0; i <= ZONE_COUNT; i++) {
  const row = document.createElement('div');
  row.className = 'mw-zone';
  row.dataset.zoneRow = String(i);
  row.innerHTML = i === 0
    ? '<h3 data-copy="ui.materialWizard.surface.base"></h3>' + zoneClassSelect(0)
      + zoneSlider(0, 'rough', 'ui.materialWizard.surface.roughness', 0, 1, 0.85)
      + zoneSlider(0, 'metal', 'ui.materialWizard.surface.metallic', 0, 1, 0)
    : '<div class="mw-slot-head"><h3 data-copy="ui.materialWizard.surface.zone" data-n="' + i + '"></h3>'
      + '<input type="checkbox" class="mw-hidden" data-zone="' + i + '" data-zone-field="on">'
      + '<button type="button" class="mw-round" data-zone-remove="' + i + '" data-title="ui.materialWizard.surface.removeZone"><i class="fa-solid fa-xmark"></i></button></div>'
      + '<div class="mw-row"><label class="mw-text"><span data-copy="ui.materialWizard.surface.zoneColor"></span> '
      + '<input type="color" data-zone="' + i + '" data-zone-field="color" value="#808080"></label>'
      + '<button type="button" data-zone-pick="' + i + '" data-copy="ui.materialWizard.surface.pick"></button></div>'
      + zoneSlider(i, 'range', 'ui.materialWizard.surface.range', 0.02, 0.6, 0.2, 'ui.materialWizard.surface.rangeTip')
      + zoneClassSelect(i)
      + zoneSlider(i, 'rough', 'ui.materialWizard.surface.roughness', 0, 1, 0.85)
      + zoneSlider(i, 'metal', 'ui.materialWizard.surface.metallic', 0, 1, 0)
      + zoneSlider(i, 'opacity', 'ui.materialWizard.surface.zoneOpacity', 0, 1, 1);
  zoneHost.appendChild(row);
}
const zonesHead = document.createElement('h3');
zonesHead.className = 'mw-sub';
zonesHead.dataset.copy = 'ui.materialWizard.surface.zones';
zoneHost.insertBefore(zonesHead, zoneHost.querySelector('[data-zone-row="1"]'));
fillCopy(zoneHost);
zoneEl(0, 'class').value = 'asphalt';

function syncZones() {
  for (let i = 1; i <= ZONE_COUNT; i++) {
    zoneHost.querySelector('[data-zone-row="' + i + '"]').hidden = !zoneEl(i, 'on').checked;
  }
}
syncZones();
armResets(document.body);
syncResets();

function controlDefault(el) {
  if (el.tagName === 'SELECT') {
    const chosen = [...el.options].find((option) => option.defaultSelected);
    return chosen ? chosen.value : el.options[0].value;
  }
  return el.defaultValue;
}

function armResets(root) {
  root.querySelectorAll('.mw-field, .mw-text').forEach((label) => {
    const el = label.querySelector('input[type="range"], input[type="number"], select');
    if (!el || label.querySelector('.mw-reset')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mw-reset mw-round';
    button.hidden = true;
    button.dataset.title = 'ui.materialWizard.resetSetting';
    button.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    label.insertBefore(button, el);
  });
  fillCopy(root);
}

function syncResets() {
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

zoneHost.addEventListener('input', (event) => {
  const el = event.target;
  if (el.dataset.zoneField !== 'class') return;
  const info = CLASSES[el.value];
  zoneEl(el.dataset.zone, 'rough').value = info.rough;
  zoneEl(el.dataset.zone, 'metal').value = info.metal;
  paintRange(zoneEl(el.dataset.zone, 'rough'));
  paintRange(zoneEl(el.dataset.zone, 'metal'));
});
zoneHost.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-zone-remove]');
  if (remove) {
    remember();
    zoneEl(remove.dataset.zoneRemove, 'on').checked = false;
    syncZones();
    commit();
    schedule();
    return;
  }
  const pick = event.target.closest('[data-zone-pick]');
  if (pick) startPick(pick, Number(pick.dataset.zonePick));
});
document.getElementById('add-zone').addEventListener('click', () => {
  for (let i = 1; i <= ZONE_COUNT; i++) {
    if (zoneEl(i, 'on').checked) continue;
    remember();
    zoneEl(i, 'on').checked = true;
    syncZones();
    commit();
    schedule();
    return;
  }
});

function readZones() {
  const num01 = (i, field) => num(zoneEl(i, field).value, 0);
  const zones = [];
  for (let i = 1; i <= ZONE_COUNT; i++) {
    if (!zoneEl(i, 'on').checked) continue;
    zones.push({ color: hexLinear(zoneEl(i, 'color').value), range: num01(i, 'range'), rough: num01(i, 'rough'), metal: num01(i, 'metal'), opacity: num01(i, 'opacity') });
  }
  return { base: [num01(0, 'rough'), num01(0, 'metal')], zones };
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (!button) return;
  const previous = document.querySelector('[data-tab].is-active');
  const wasTile = previous.dataset.tab === 'tile';
  const tabs = Array.from(document.querySelectorAll('#tabs [data-tab]'));
  const back = tabs.indexOf(button) < tabs.indexOf(previous);
  document.querySelectorAll('[data-tab]').forEach((el) => el.classList.toggle('is-active', el === button));
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    const show = panel.getAttribute('data-panel') === button.dataset.tab;
    panel.classList.toggle('mw-hidden', !show);
    if (show) enterContent(panel, back);
  });
  if (TAB_VIEW[button.dataset.tab]) showView(TAB_VIEW[button.dataset.tab]);
  if (mobile.matches) {
    const bar = button.parentElement;
    bar.scrollTo({ left: bar.scrollLeft + button.getBoundingClientRect().left - bar.getBoundingClientRect().left, behavior: 'smooth' });
  }
  if (wasTile && button.dataset.tab !== 'tile') flushTileWork();
  refreshEditor();
});

const TAB_VIEW = { albedo: 'albedo', shape: 'height', surface: 'rough', export: 'preview' };

document.querySelector('[data-panel="albedo"]').addEventListener('input', (event) => {
  if (event.target.type === 'range' && event.target.dataset.param !== 'shadowFix' && event.target.dataset.param !== 'lightRange' && event.target.dataset.param !== 'lightStrength') document.querySelector('[data-param="albedoFix"]').checked = true;
}, true);

function enterContent(panel, back) {
  Array.from(panel.children).forEach((child, i) => child.style.setProperty('--i', Math.min(i, 10)));
  panel.style.setProperty('--mw-from', back ? '-40px' : '40px');
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

function hexLinear(value) {
  return hexColor(value).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
}

function readParams() {
  const params = {
    delight: 0.65, highlight: 0.8, relief: 0, shadowFix: 0, targetMean: 0.18,
    evenOut: 0, brightX: 0, brightXPos: 0.5, brightY: 0, brightYPos: 0.5,
    heightRelief: 0.35, heightContrast: 1.5, heightBias: 0, heightLevel: 0,
    normalStrength: 1, normalSmooth: 0.5, flipY: false, aoDepth: 1, aoContrast: 1, metalWear: 0, metalSharp: 1,
    detailStrength: 0.7, detailCutoff: 0.65, detailAuto: true, detailFlatOnly: 0.35, atlas: false, addDetail: false,
    addAoDetail: false, aoDetailAmount: 1, aoDetailSize: 0.5, addRoughDetail: false, roughDetailAmount: 1, roughDetailSize: 0.5, addMetalDetail: false, metalDetailAmount: 1, metalDetailSize: 0.5,
    tileOn: false, tileLeft: true, tileRight: false, tileUp: true, tileDown: false,
    leftA: 0.03, leftB: 0.2, rightA: 0.03, rightB: 0.2, upA: 0.03, upB: 0.2, downA: 0.03, downB: 0.2,
    tileBlend: 'cut', tileSoft: 0.3, tileEven: true, crop: '', cropShape: 'auto', roadRuns: 'up', roadWidth: 7,
    cavityRough: 0.25, wearRough: 0.1, microRough: 0.15, specRough: 0.35, nvarRough: 0.2,
    roughMin: 0.15, roughMax: 0.95, roughContrast: 1,
    opacityEdge: 0, opacityRagged: 0.4, opacityPatch: 0, opacityCrack: 0,
    split: 0, seamLines: false, shape: 'plane', layout: '1x1',
    size: 'source', pot: 'auto', previewSize: '2048', name: 'm_example', folder: '/levels/example/art/textures/',
    profile: 'level', annotation: 'ASPHALT', alphaRef: 150, albedoFix: false,
    whiteBalance: whiteBalance,
    lightColors: lightColors.map(hexLinear),
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
  params.light = [sunAngle.az, sunAngle.el];
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
let lightColors = [];
const LIGHT_COLORS_MAX = 4;

const lightHost = document.getElementById('light-colors');

function renderLightColors() {
  lightHost.innerHTML = '';
  lightColors.forEach((hex, i) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'mw-swatch';
    swatch.style.background = hex;
    swatch.dataset.lightRemove = String(i);
    swatch.title = text('ui.materialWizard.albedo.lightRemove');
    lightHost.appendChild(swatch);
  });
  const picked = lightColors.length > 0;
  document.getElementById('light-options').classList.toggle('mw-hidden', !picked);
  document.getElementById('clear-light').classList.toggle('mw-hidden', !picked);
}

const HISTORY_LIMIT = 30;
const HISTORY_CONTROL = '[data-param], [data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor], [data-zone], #quad, #orm-order';
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
  syncResets();
}

function takeSnapshot() {
  const names = {};
  document.querySelectorAll('[data-file-name]').forEach((el) => { names[el.dataset.fileName] = el.textContent; });
  return {
    original,
    slots: Object.assign({}, slotImages),
    whiteBalance: whiteBalance ? whiteBalance.slice() : null,
    lightColors: lightColors.slice(),
    lights: lights.map((light) => ({ image: light.image, az: light.az, el: light.el })),
    mask: document.getElementById('mask-file')._image || null,
    names,
    controls: readControls(),
    photoBytes,
    photoName,
  };
}

function sameSnapshot(a, b) {
  if (a.original !== b.original || a.mask !== b.mask) return false;
  if ((a.whiteBalance || []).join() !== (b.whiteBalance || []).join()) return false;
  if (a.lightColors.join() !== b.lightColors.join()) return false;
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
  photoBytes = snap.photoBytes || null;
  photoName = snap.photoName || null;
  Object.keys(slotImages).forEach((key) => delete slotImages[key]);
  Object.assign(slotImages, snap.slots);
  whiteBalance = snap.whiteBalance ? snap.whiteBalance.slice() : null;
  lightColors = snap.lightColors.slice();
  renderLightColors();
  lights = snap.lights.map((light) => ({ image: light.image, az: light.az, el: light.el }));
  document.getElementById('mask-file')._image = snap.mask;
  writeControls(snap.controls);
  syncZones();
  document.querySelectorAll('[data-file-name]').forEach((el) => {
    el.textContent = snap.names[el.dataset.fileName] || text('ui.materialWizard.maps.choose');
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
  appbar.querySelector('[data-app="undo"]').disabled = undoStack.length === 0;
  appbar.querySelector('[data-app="redo"]').disabled = redoStack.length === 0;
}

const appbar = document.getElementById('appbar');
const mobile = window.matchMedia('(max-width: 900px)');
let compareView = null;
appbar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-app]');
  if (!button) return;
  const action = button.dataset.app;
  if (action === 'open') pickAndOpen();
  else if (action === 'undo') undo();
  else if (action === 'redo') redo();
  else if (action === 'download') document.getElementById('download').click();
  else if (action === 'more') {
    const body = document.body;
    if (body.classList.contains('mw-more-closing')) return;
    if (body.classList.contains('mw-more-open')) {
      body.classList.add('mw-more-closing');
      setTimeout(() => {
        body.classList.remove('mw-more-open', 'mw-more-closing');
        body.style.setProperty('--mw-appbar-h', appbar.offsetHeight + 'px');
      }, 160);
    } else {
      body.classList.add('mw-more-open');
      body.style.setProperty('--mw-appbar-h', appbar.offsetHeight + 'px');
    }
  }
});
const compareButton = appbar.querySelector('[data-app="compare"]');
compareButton.addEventListener('pointerdown', () => {
  if (compareView || !original) return;
  compareView = viewSelect.value;
  showView('source');
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => compareButton.addEventListener(type, () => {
  if (!compareView) return;
  showView(compareView);
  compareView = null;
}));

// Pivot swipe: the open panel and the header strip follow the finger, then snap back or turn the page.
let swipeFrom = null;
let swipeDragged = false;
const aside = document.querySelector('.mw-page > aside');
const tabsBar = document.getElementById('tabs');
const tabOrder = () => Array.from(document.querySelectorAll('#tabs [data-tab]'));
const activePanel = () => aside.querySelector('[data-panel]:not(.mw-hidden)');

function swipeTarget(dx) {
  const tabs = tabOrder();
  const index = tabs.findIndex((tab) => tab.classList.contains('is-active'));
  return tabs[index + (dx < 0 ? 1 : -1)] || null;
}

function moveSwipe(dx) {
  const panel = activePanel();
  const pull = swipeTarget(dx) ? dx : dx * 0.3;
  const fade = Math.min(1, Math.abs(pull) / aside.clientWidth);
  if (panel) {
    panel.style.transform = 'translateX(' + pull + 'px)';
    panel.style.opacity = String(1 - fade * 0.6);
  }
  tabsBar.style.transform = 'translateX(' + pull * 0.35 + 'px)';
}

function endSwipe(animate) {
  [activePanel(), tabsBar].forEach((el) => {
    if (!el) return;
    el.classList.toggle('mw-swipe-back', animate);
    el.style.transform = '';
    el.style.opacity = '';
  });
  if (animate) setTimeout(() => aside.querySelectorAll('.mw-swipe-back').forEach((el) => el.classList.remove('mw-swipe-back')), 260);
}

aside.addEventListener('pointerdown', (event) => {
  swipeDragged = false;
  swipeFrom = mobile.matches && event.isPrimary && !event.target.closest('input, select, textarea, canvas, .mw-tabs')
    ? { x: event.clientX, y: event.clientY, horizontal: null } : null;
});
aside.addEventListener('pointermove', (event) => {
  if (!swipeFrom) return;
  const dx = event.clientX - swipeFrom.x;
  const dy = event.clientY - swipeFrom.y;
  if (swipeFrom.horizontal === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    swipeFrom.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
  }
  if (!swipeFrom.horizontal) return;
  swipeDragged = true;
  moveSwipe(dx);
});
aside.addEventListener('pointerup', (event) => {
  if (!swipeFrom) return;
  const dx = event.clientX - swipeFrom.x;
  const horizontal = swipeFrom.horizontal;
  swipeFrom = null;
  if (!horizontal) return;
  const next = Math.abs(dx) >= 60 ? swipeTarget(dx) : null;
  endSwipe(!next);
  if (next) next.click();
});
aside.addEventListener('pointercancel', () => {
  if (!swipeFrom) return;
  swipeFrom = null;
  endSwipe(true);
});
aside.addEventListener('click', (event) => {
  if (!swipeDragged) return;
  swipeDragged = false;
  if (!event.target.closest('.mw-tabs')) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

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
  document.querySelectorAll('[data-zone]').forEach((el) => {
    values['z:' + el.dataset.zone + ':' + el.dataset.zoneField] = controlValue(el);
  });
  values.quad = document.getElementById('quad').value;
  values.orm = document.getElementById('orm-order').value;
  return values;
}

function migrateValues(values) {
  if (values && values['p:mapDetailSize'] != null) {
    ['aoDetailSize', 'roughDetailSize', 'metalDetailSize'].forEach((name) => {
      if (values['p:' + name] == null) values['p:' + name] = values['p:mapDetailSize'];
    });
  }
  return values;
}

function writePreset(values) {
  migrateValues(values);
  document.querySelectorAll('[data-param]').forEach((el) => setControl(el, values['p:' + el.dataset.param]));
  document.querySelectorAll(SLOT_CONTROLS).forEach((el) => {
    setControl(el, values['s:' + slotControlKey(el)]);
  });
  document.querySelectorAll('[data-zone]').forEach((el) => {
    setControl(el, values['z:' + el.dataset.zone + ':' + el.dataset.zoneField]);
  });
  syncZones();
  syncResets();
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
  none.textContent = text('ui.materialWizard.presets.none');
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
document.getElementById('preset-export').addEventListener('click', () => {
  const all = storedPresets();
  const name = presetList.value;
  const presets = name ? { [name]: all[name] } : all;
  if (!Object.keys(presets).length) return;
  const json = JSON.stringify({ materialWizardPresets: 1, version: VERSION, presets });
  const file = (name || 'material-wizard-presets').replace(/[^a-z0-9_-]+/gi, '_') + '.mwpreset.json';
  downloadBytes(new TextEncoder().encode(json), file, 'application/json');
});
const presetFile = document.getElementById('preset-file');
document.getElementById('preset-import').addEventListener('click', () => presetFile.click());
presetFile.addEventListener('change', async () => {
  const file = presetFile.files[0];
  presetFile.value = '';
  if (!file) return;
  let incoming = null;
  try {
    const parsed = JSON.parse(await file.text());
    incoming = parsed.presets;
    if (versionNewer(parsed.version)) sessionNote = text('ui.materialWizard.notes.newerFile', { v: parsed.version });
  } catch (e) { /* not a preset file */ }
  if (!incoming || typeof incoming !== 'object') {
    warningsEl.textContent = text('ui.materialWizard.notes.badFile', { name: file.name });
    return;
  }
  const presets = Object.assign(storedPresets(), incoming);
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) { /* ignore */ }
  fillPresetList(Object.keys(incoming)[0]);
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

// Tile drags only refresh the base-color preview. The other maps are built after the edit pauses.
const TILE_EDIT = new Set([
  'crop', 'cropShape', 'tileOn', 'tileLeft', 'tileRight', 'tileUp', 'tileDown',
  'tileBlend', 'tileSoft', 'roadRuns', 'roadWidth', 'seamLines',
  'leftA', 'leftB', 'rightA', 'rightB', 'upA', 'upB', 'downA', 'downB',
]);
const TILE_IDLE = 2000;

function scheduleTileWork() {
  clearTimeout(tileIdle);
  tileIdle = setTimeout(() => {
    tileIdle = 0;
    schedule();
  }, TILE_IDLE);
}

function flushTileWork() {
  if (!tileIdle) return;
  clearTimeout(tileIdle);
  tileIdle = 0;
  schedule();
}

function canvasFromRGBA(rgba, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return c;
}

function imageDataOf(image, w = image.width, h = image.height) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  return data;
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

function uploadPainted(set, image, w, h) {
  const c = paint(image, w, h);
  try { set(c); } finally { c.width = c.height = 0; }
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
  if (viewSelect.value === 'preview') {
    viewZoom.x = Math.min(1, Math.max(0, viewZoom.x));
    viewZoom.y = Math.min(1, Math.max(0, viewZoom.y));
    return;
  }
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

let hdrCanvas = document.getElementById('view-hdr');
const hdrNote = document.getElementById('hdr-note');
const HDR_PEAK = 1000;
// { kind: 'gpu', device, ctx } for a WebGPU extended canvas, or { kind: 'pq', ctx, key } for a rec2100-pq 2D canvas.
let hdrOut = null;
let hdrProbe = null;

function hdrScreen() {
  return window.matchMedia('(dynamic-range: high)').matches;
}

async function gpuHdr() {
  if (!navigator.gpu || typeof GPUTextureUsage === 'undefined') return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgpu');
    if (!ctx) { device.destroy(); return null; }
    ctx.configure({
      device,
      format: 'rgba16float',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      toneMapping: { mode: 'extended' },
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    const conf = ctx.getConfiguration && ctx.getConfiguration();
    if (!conf || !conf.toneMapping || conf.toneMapping.mode !== 'extended') {
      ctx.unconfigure();
      device.destroy();
      return null;
    }
    c.id = hdrCanvas.id;
    c.hidden = true;
    c.setAttribute('aria-hidden', 'true');
    hdrCanvas.replaceWith(c);
    hdrCanvas = c;
    device.lost.then(() => {
      if (hdrOut && hdrOut.device === device) { hdrOut = null; hdrProbe = null; hideHdr(); }
    });
    return { kind: 'gpu', device, ctx };
  } catch (e) {
    console.warn('Material Wizard: WebGPU HDR unavailable', e);
    return null;
  }
}

function pqHdr() {
  if (typeof Float16Array === 'undefined') return null;
  const tries = [
    ['colorType', { colorSpace: 'rec2100-pq', colorType: 'float16' }],
    ['pixelFormat', { colorSpace: 'rec2100-pq', pixelFormat: 'float16' }],
  ];
  const off = document.createElement('canvas');
  if (typeof off.configureHighDynamicRange === 'function') {
    try { off.configureHighDynamicRange({ mode: 'extended' }); } catch (e) { /* the context options carry it */ }
  }
  for (const [key, opt] of tries) {
    try {
      const probe = off.getContext('2d', opt);
      const attr = probe && probe.getContextAttributes && probe.getContextAttributes();
      const type = attr && (attr.colorType || attr.pixelFormat);
      if (!attr || attr.colorSpace !== 'rec2100-pq' || type !== 'float16') continue;
      if (typeof hdrCanvas.configureHighDynamicRange === 'function') {
        try { hdrCanvas.configureHighDynamicRange({ mode: 'extended' }); } catch (e) { /* the context options carry it */ }
      }
      const ctx = hdrCanvas.getContext('2d', opt);
      return ctx ? { kind: 'pq', ctx, key } : null;
    } catch (e) { /* next */ }
  }
  return null;
}

// Returns the HDR output once it is known; the first call starts the probe and redraws when it finishes.
function hdrReady() {
  if (hdrOut || hdrProbe) return hdrOut;
  hdrProbe = (async () => {
    hdrOut = (await gpuHdr()) || pqHdr();
    console.log('Material Wizard: HDR output', hdrOut ? hdrOut.kind : 'none');
    if (hdrOut && original && viewSelect.value === 'preview') presentCurrent();
  })();
  return null;
}

let hdrBits = null;

function float16Bits(src) {
  if (!hdrBits || hdrBits.length !== src.length) hdrBits = new Uint16Array(src.length);
  const bits = hdrBits;
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i];
    const x = u[0];
    const sign = (x >>> 16) & 0x8000;
    if ((x & 0x7fffffff) < 0x38800000) { bits[i] = sign; continue; }
    if ((x & 0x7fffffff) > 0x477fe000) { bits[i] = sign | 0x7c00; continue; }
    bits[i] = sign | ((((x >>> 23) & 0xff) - 112) << 10) | ((x >>> 13) & 0x3ff);
  }
  return bits;
}

function hideHdr() {
  drop.classList.remove('is-hdr');
  hdrCanvas.hidden = true;
  hdrBits = null;
  if (hdrCanvas.width > 1) hdrCanvas.width = hdrCanvas.height = 1;
}

function syncHdrNote() {
  const show = viewSelect.value === 'preview' && drop.classList.contains('is-hdr');
  hdrNote.hidden = !show;
  if (show) hdrNote.textContent = text('ui.materialWizard.preview.hdr', { nits: HDR_PEAK });
}

function presentHdr(frame) {
  if (!frame || !hdrOut) { hideHdr(); return; }
  if (hdrCanvas.width !== frame.w || hdrCanvas.height !== frame.h) {
    hdrCanvas.width = frame.w;
    hdrCanvas.height = frame.h;
  }
  const bits = frame.half ? frame.data : float16Bits(frame.data);
  try {
    if (hdrOut.kind === 'gpu') {
      hdrOut.device.queue.writeTexture(
        { texture: hdrOut.ctx.getCurrentTexture() },
        bits,
        { bytesPerRow: frame.w * 8 },
        { width: frame.w, height: frame.h },
      );
    } else {
      const opt = { colorSpace: 'rec2100-pq' };
      opt[hdrOut.key] = 'float16';
      hdrOut.ctx.putImageData(new ImageData(new Float16Array(bits.buffer, bits.byteOffset, bits.length), frame.w, frame.h, opt), 0, 0);
    }
  } catch (e) {
    console.warn('Material Wizard: HDR present failed', e);
    hdrOut = null;
    hideHdr();
    return;
  }
  hdrCanvas.hidden = false;
  drop.classList.add('is-hdr');
}

function presentCurrent() {
  const params = readParams();
  const preview = viewSelect.value === 'preview';
  const out = preview && hdrScreen() && !engine.hdrFailed() ? hdrReady() : null;
  const hdr = out ? (out.kind === 'gpu' ? 'srgb' : 'pq') : null;
  engine.present(viewSelect.value, {
    split: params.split,
    layout: params.layoutPair,
    seamLines: params.seamLines,
    shape: params.shape,
    light: params.light,
    rot: previewRot,
    zoom: viewZoom.zoom,
    center: [viewZoom.x, viewZoom.y],
    viewSize: preview ? previewViewSize() : null,
    hdr,
  });
  if (hdr) presentHdr(engine.hdrFrame());
  else hideHdr();
  syncHdrNote();
}

new ResizeObserver(() => {
  if (viewSelect.value === 'preview' && original) presentCurrent();
}).observe(drop);
window.matchMedia('(dynamic-range: high)').addEventListener('change', () => {
  if (original) presentCurrent();
  else syncHdrNote();
});

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
  uploadPainted((c) => engine.setSource(c), tile.source, size.w, size.h);
  for (const [name] of SLOTS) {
    const mode = document.querySelector('[data-slot-mode="' + name + '"]').value;
    if (name !== 'albedo' && mode === 'load' && slotImages[name]) uploadPainted((c) => engine.setLoaded(mapName(name), c), tile.slots[name], size.w, size.h);
    else engine.setLoaded(mapName(name), null);
  }
  const maskFile = document.getElementById('mask-file')._image;
  if (maskFile) uploadPainted((c) => engine.setMask(c), maskFile, size.w, size.h);
  else engine.setMask(null);
  const warnings = engine.update(params) || [];
  if (engine.lost()) throw new Error('gpu-oom');
  return warnings;
}

function outputSize(sourceImage, tile, params) {
  const wanted = tile.pow2 && params.size === 'source' ? tile.pow2 : workingSize(sourceImage, params.size, params.pot);
  return { wanted, size: capSize(wanted, engine.maxSize()) };
}

// Runs fn with the engine at the output size, then goes back to the preview size.
async function atOutputSize(fn) {
  if (!(await renderReady())) throw new Error(text('ui.materialWizard.notes.gpuLost'));
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
    if (targetAspect && Math.abs(aspect - targetAspect) / targetAspect > 0.15) extra.push(text('ui.materialWizard.notes.stretch'));
  }
  if (size.w !== wanted.w || size.h !== wanted.h) {
    extra.push(text('ui.materialWizard.notes.exportCap', { w: wanted.w, h: wanted.h, sw: size.w, sh: size.h }));
  }
  extra.forEach((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    warningsEl.appendChild(p);
  });
  return value;
}

async function render() {
  clearTimeout(tileIdle);
  tileIdle = 0;
  SLOTS.forEach(([name]) => syncSlot(name));
  syncViewButtons();
  if (!original) return;
  const params = readParams();
  const loadedNames = SLOTS.map(([name]) => name).filter((name) => name !== 'albedo' && slotImages[name] && document.querySelector('[data-slot-mode="' + name + '"]').value === 'load');
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
  shapeSelect.querySelector('[value="auto"]').textContent = detected ? text('ui.materialWizard.maps.autoDetected', { shape: detected }) : text('ui.materialWizard.maps.auto');
  shapeSelect.disabled = params.size === 'source' && !detected;
  if (gpuLost) return false;
  const natural = tile.pow2 ? tile.pow2 : workingSize(sourceImage, 'source', params.pot);
  const asked = params.previewSize === 'full' ? Infinity : num(params.previewSize, 2048);
  const work = capSize(natural, Math.min(asked, gpuLimit()));
  const notes = [];
  if (oomInfo) notes.push(text('ui.materialWizard.notes.gpuOom', oomInfo));
  if (tile.clipped.length) {
    notes.push(text('ui.materialWizard.notes.tileMargin', { sides: tile.clipped.map((side) => text('ui.materialWizard.notes.sideNames.' + side)).join(', ') }));
  }
  document.getElementById('seam-note').textContent = tile.scores
    ? text('ui.materialWizard.notes.seam', { x: seamRate(tile.scores.x), y: seamRate(tile.scores.y) })
    : '';
  if (Math.max(work.w, work.h) + 0.5 < Math.min(Math.max(natural.w, natural.h), asked)) {
    notes.push(text('ui.materialWizard.notes.gpuCap', { w: natural.w, h: natural.h, sw: work.w, sh: work.h }));
  }
  SLOTS.forEach(([name]) => {
    const stored = slotImages[name];
    if (stored && name !== 'albedo' && document.querySelector('[data-slot-mode="' + name + '"]').value === 'load'
      && (stored.width !== original.width || stored.height !== original.height)) {
      notes.push(text('ui.materialWizard.notes.resampled', { name: name }));
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
    ? text('ui.materialWizard.notes.road', { width: params.roadWidth, length: length.toFixed(2), ...factorVars })
    : text('ui.materialWizard.notes.factors', factorVars);
  warningsEl.innerHTML = '';
  notes.concat(warnings).forEach((line) => {
    const p = document.createElement('p');
    p.textContent = text('ui.materialWizard.notes.' + line) || line;
    warningsEl.appendChild(p);
  });
  if (sessionNote) {
    const p = document.createElement('p');
    p.textContent = sessionNote;
    warningsEl.appendChild(p);
  }
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
  return { cut: params.tileBlend === 'cut', soft: params.tileSoft, even: params.tileEven !== false, lightColors: params.lightColors, lightRange: params.lightRange, lightStrength: params.lightStrength };
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
  const datas = [imageDataOf(base).data].concat(slotNames.map((name) => imageDataOf(sources[name], W, H).data));
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

function activeTab() {
  const active = document.querySelector('[data-tab].is-active');
  return active ? active.dataset.tab : '';
}

function tileTabActive() {
  return activeTab() === 'tile';
}

function fixTabActive() {
  return activeTab() === 'fix';
}

let editorQueued = false;
function refreshEditor() {
  if (editorQueued) return;
  editorQueued = true;
  requestAnimationFrame(() => {
    editorQueued = false;
    paintEditor();
  });
}

function paintEditor() {
  if (!original || !(tileTabActive() || fixTabActive())) {
    editor.show(null);
    tileBar.hidden = true;
    return;
  }
  const tileSeg = tileBar.querySelector('.mw-seg');
  if (fixTabActive() && fixMode === 'crop') {
    const preview = previewOf(original);
    const frame = cropFrame();
    tileBar.hidden = false;
    tileSeg.hidden = true;
    editor.show({
      base: preview.base,
      frame,
      sides: NO_SIDES,
      ratio: frameRatio(adjustShape.value, original.width, original.height),
      view: 'frame',
      labels: { size: text('ui.materialWizard.tile.frameSize', { w: Math.round(frame.w * original.width), h: Math.round(frame.h * original.height) }) },
    });
    return;
  }
  if (fixTabActive()) {
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
        labels: { angle: fixAngle().toFixed(1) + '°', result: text('ui.materialWizard.fix.result') },
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
    off: !tileActive(params),
    labels: {
      off: text('ui.materialWizard.tile.offNote'),
      beyond: { left: text('ui.materialWizard.tile.beyondLeft'), right: text('ui.materialWizard.tile.beyondRight'), up: text('ui.materialWizard.tile.beyondUp'), down: text('ui.materialWizard.tile.beyondDown') },
      size: text('ui.materialWizard.tile.frameSize', { w: Math.round(frame.w * full.width), h: Math.round(frame.h * full.height) }),
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
  if (value == null) return text('ui.materialWizard.notes.seamOff');
  const rate = value < 0.04 ? 'seamGood' : value < 0.08 ? 'seamFaint' : 'seamBad';
  return text('ui.materialWizard.notes.seamRate', { rate: text('ui.materialWizard.notes.' + rate), value: value.toFixed(3) });
}

function frameString(frame) {
  return [frame.x, frame.y, frame.w, frame.h].map((v) => v.toFixed(5)).join(',');
}

const quadInput = document.getElementById('quad');
const angleInput = document.getElementById('fix-angle');
const IDENTITY_QUAD = [0, 0, 1, 0, 1, 1, 0, 1];
let fixMode = 'rotate';
let adjustFrame = '';
const adjustShape = document.getElementById('adjust-shape');
const NO_SIDES = { left: { on: false, a: 0, b: 0 }, right: { on: false, a: 0, b: 0 }, up: { on: false, a: 0, b: 0 }, down: { on: false, a: 0, b: 0 } };

function cropFrame() {
  if (!original) return { x: 0, y: 0, w: 1, h: 1 };
  return parseFrame(adjustFrame) || autoFrame(original.width, original.height, frameRatio(adjustShape.value, original.width, original.height), NO_SIDES);
}

function cropCanvas(image, frame) {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(frame.x * image.width)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(frame.y * image.height)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.min(image.width - x, Math.round(frame.w * image.width)));
  c.height = Math.max(1, Math.min(image.height - y, Math.round(frame.h * image.height)));
  c.getContext('2d').drawImage(image, x, y, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}
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
    fixCache.data = imageDataOf(base, Math.max(1, Math.round(base.width * scale)), Math.max(1, Math.round(base.height * scale)));
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
    if (fixTabActive()) {
      if (fixMode === 'crop' && original && !parseFrame(adjustFrame)) adjustFrame = frameString(cropFrame());
      return;
    }
    if (!parseFrame(cropInput.value)) {
      const params = readParams();
      const full = orientedOriginal(params.roadRuns);
      cropInput.value = frameString(currentFrame(params, full.width, full.height));
    }
  },
  onFrame(frame) {
    if (fixTabActive() && fixMode === 'crop') {
      adjustFrame = frameString(frame);
      refreshEditor();
      return;
    }
    framing = true;
    cropInput.value = frameString(frame);
    refreshEditor();
    scheduleTileWork();
  },
  onFade(side, key, value) {
    document.querySelector('[data-param="' + side + key.toUpperCase() + '"]').value = value;
    refreshEditor();
    scheduleTileWork();
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
    if (fixTabActive()) return;
    if (framing) framing = false;
    refreshEditor();
    scheduleTileWork();
  },
  onView: setTileView,
});

document.querySelector('[data-param="cropShape"]').addEventListener('input', () => { cropInput.value = ''; });
document.getElementById('fit-frame').addEventListener('click', () => {
  remember();
  cropInput.value = '';
  commit();
  scheduleTileWork();
  refreshEditor();
});

async function renderReady() {
  for (let i = 0; i < 4 && !gpuLost; i++) {
    if (await render()) return true;
  }
  return false;
}

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
  warningsEl.textContent = text('ui.materialWizard.notes.gpuLost');
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
  syncResets();
  if (event.target.matches('[data-param="size"]')) {
    const shapeSelect = document.querySelector('[data-param="pot"]');
    const image = lastRender && lastRender.tile && lastRender.tile.source;
    const detected = image && potShape(image.width, image.height);
    shapeSelect.disabled = event.target.value === 'source' && !detected;
    return;
  }
  if (event.target.matches('[data-param], [data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor], [data-zone]')) {
    if (tileTabActive() && TILE_EDIT.has(event.target.dataset.param)) {
      refreshEditor();
      scheduleTileWork();
      return;
    }
    schedule();
    refreshEditor();
  }
});
document.body.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-slot-file]');
  if (!input || !input.files[0]) return;
  const slot = input.dataset.slotFile;
  const file = input.files[0];
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = await loadImage(new Blob([bytes], { type: file.type || 'image/png' }));
  if (slot === 'albedo') {
    useImage(image, file, bytes);
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
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  useImage(await loadImage(new Blob([bytes], { type: file.type || 'image/png' })), file, bytes);
});

function nameFromFile(file) {
  if (!file || !file.name || /^image\.\w+$/i.test(file.name)) return '';
  return classify(file.name).base.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '');
}

function setNameFrom(file) {
  const name = nameFromFile(file);
  if (name) document.querySelector('[data-param="name"]').value = name;
}

function photoFileName(file) {
  const ext = ((file && file.name || '').split('.').pop() || 'png').toLowerCase();
  return 'photo.' + ({ jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' }[ext] || 'png');
}

function useImage(image, file, bytes) {
  remember();
  projectHandle = null;
  sessionNote = '';
  SLOTS.forEach(([name]) => {
    if (name === 'albedo') return;
    delete slotImages[name];
    setSlotMode(name, 'generate');
    document.querySelector('[data-file-name="' + name + '"]').textContent = text('ui.materialWizard.maps.choose');
  });
  original = image;
  photoBytes = bytes || null;
  photoName = bytes ? photoFileName(file) : null;
  slotImages.albedo = image;
  setSlotMode('albedo', 'load');
  document.querySelector('[data-file-name="albedo"]').textContent = file && file.name ? file.name : text('ui.materialWizard.maps.choose');
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
  if (file && file.type.startsWith('image/')) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    useImage(await loadImage(new Blob([bytes], { type: file.type })), file, bytes);
  }
});
window.addEventListener('paste', async (event) => {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      useImage(await loadImage(new Blob([bytes], { type: file.type || 'image/png' })), file, bytes);
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

const loupe = document.getElementById('loupe');
const loupeCanvas = loupe.querySelector('canvas');
const loupeLabel = loupe.querySelector('span');
const loupeSource = document.createElement('canvas');
loupeSource.width = loupeSource.height = 15;

function srgbByte(value) {
  const c = value / 255;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

function sampleMap(map, px, py) {
  let r = 0, g = 0, b = 0, n = 0;
  const x = Math.max(0, Math.min(map.w - 1, px));
  const y = Math.max(0, Math.min(map.h - 1, py));
  for (let sy = Math.max(0, y - 3); sy <= Math.min(map.h - 1, y + 3); sy++) {
    for (let sx = Math.max(0, x - 3); sx <= Math.min(map.w - 1, x + 3); sx++) {
      const i = (sy * map.w + sx) * 4;
      r += map.rgba[i]; g += map.rgba[i + 1]; b += map.rgba[i + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;
  const hex = [r, g, b].map((v) => srgbByte(v).toString(16).padStart(2, '0')).join('');
  return { r: r / 255, g: g / 255, b: b / 255, hex };
}

function mapPixel(event, map) {
  const uv = viewUv(event);
  const [repeatX, repeatY] = picker.repeat;
  const u = ((uv.x - 0.5) / viewZoom.zoom + viewZoom.x) * repeatX;
  const v = ((uv.y - 0.5) / viewZoom.zoom + viewZoom.y) * repeatY;
  return {
    x: Math.floor((u - Math.floor(u)) * map.w),
    y: Math.floor((1 - (v - Math.floor(v))) * map.h),
  };
}

function cancelPick(restoreView = true) {
  if (!picker) return;
  const previous = picker.previousView;
  drop.classList.remove('mw-picking');
  picker.button.classList.remove('mw-armed');
  fillCopy(picker.button.parentElement || picker.button);
  picker = null;
  loupe.hidden = true;
  canvas.style.cursor = viewZoom.zoom > 1 ? 'grab' : '';
  if (restoreView && viewSelect.value === 'source') showView(previous);
}

function startPick(button, zone, light) {
  if (picker && picker.button === button) { cancelPick(); return; }
  const previousView = picker ? picker.previousView : viewSelect.value;
  cancelPick(false);
  const map = engine.readMap('source');
  if (!map) return;
  showView('source');
  picker = { button, zone, light, map, previousView, repeat: readParams().layoutPair, moved: false, down: null };
  drop.classList.add('mw-picking');
  button.classList.add('mw-armed');
  const label = button.querySelector('[data-copy]') || button;
  label.textContent = text('ui.materialWizard.pick.hint');
  canvas.style.cursor = 'crosshair';
}

function drawLoupe(event) {
  if (!picker || (event.pointerType === 'touch' && !event.buttons)) { loupe.hidden = true; return; }
  const map = picker.map;
  const pixel = mapPixel(event, map);
  const ctx = loupeSource.getContext('2d');
  const img = ctx.createImageData(15, 15);
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const sx = Math.max(0, Math.min(map.w - 1, pixel.x - 7 + x));
      const sy = Math.max(0, Math.min(map.h - 1, pixel.y - 7 + y));
      const i = (sy * map.w + sx) * 4;
      const o = (y * 15 + x) * 4;
      img.data[o] = srgbByte(map.rgba[i]);
      img.data[o + 1] = srgbByte(map.rgba[i + 1]);
      img.data[o + 2] = srgbByte(map.rgba[i + 2]);
      img.data[o + 3] = 255;
      if (x >= 4 && x <= 10 && y >= 4 && y <= 10 && (x === 4 || x === 10 || y === 4 || y === 10)) {
        img.data[o] = 241; img.data[o + 1] = 90; img.data[o + 2] = 34;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const view = loupeCanvas.getContext('2d');
  view.imageSmoothingEnabled = false;
  view.drawImage(loupeSource, 0, 0, 96, 96);
  loupeLabel.textContent = '#' + sampleMap(map, pixel.x, pixel.y).hex;
  const flipX = event.clientX > window.innerWidth - 140;
  const flipY = event.clientY > window.innerHeight - 150;
  loupe.style.left = (event.clientX + (flipX ? -112 : 16)) + 'px';
  loupe.style.top = (event.clientY + (flipY ? -120 : 16)) + 'px';
  loupe.hidden = false;
}

function applyPick(event) {
  const pixel = mapPixel(event, picker.map);
  const sample = sampleMap(picker.map, pixel.x, pixel.y);
  remember();
  if (picker.light) {
    lightColors = lightColors.concat('#' + sample.hex).slice(-LIGHT_COLORS_MAX);
    renderLightColors();
  } else if (picker.zone) {
    zoneEl(picker.zone, 'color').value = '#' + sample.hex;
    fillCopy(zoneHost);
  } else {
    const yv = 0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b;
    whiteBalance = [yv / Math.max(0.02, sample.r), yv / Math.max(0.02, sample.g), yv / Math.max(0.02, sample.b)];
  }
  cancelPick();
  commit();
  schedule();
}

function autoWhite() {
  const map = engine.readMap('source');
  if (!map) return;
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.max(map.w, map.h) / 48));
  for (let y = 0; y < map.h; y += step) {
    for (let x = 0; x < map.w; x += step) {
      const i = (y * map.w + x) * 4;
      const R = map.rgba[i] / 255, G = map.rgba[i + 1] / 255, B = map.rgba[i + 2] / 255;
      const yv = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (yv < 0.05 || yv > 0.75 || (mx > 0.0001 && (mx - mn) / mx > 0.2)) continue;
      r += R; g += G; b += B; n++;
    }
  }
  if (!n) return;
  r /= n; g /= n; b /= n;
  const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  remember();
  whiteBalance = [yv / Math.max(0.02, r), yv / Math.max(0.02, g), yv / Math.max(0.02, b)];
  commit();
  schedule();
}

document.getElementById('pick-white').addEventListener('click', () => startPick(document.getElementById('pick-white'), 0));
document.getElementById('pick-light').addEventListener('click', () => startPick(document.getElementById('pick-light'), 0, true));
document.getElementById('clear-light').addEventListener('click', () => { remember(); lightColors = []; renderLightColors(); commit(); schedule(); });
lightHost.addEventListener('click', (event) => {
  const swatch = event.target.closest('[data-light-remove]');
  if (!swatch) return;
  remember();
  lightColors.splice(Number(swatch.dataset.lightRemove), 1);
  renderLightColors();
  commit();
  schedule();
});
document.getElementById('auto-white').addEventListener('click', autoWhite);
document.getElementById('clear-white').addEventListener('click', () => { remember(); whiteBalance = null; commit(); schedule(); });
let panFrom = null;
const touches = new Map();
let pinch = null;
function pinchState() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1) event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  if (event.pointerType === 'touch') {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) { pinch = pinchState(); panFrom = null; return; }
    if (touches.size > 2) return;
  }
  panFrom = { x: event.clientX, y: event.clientY };
  if (picker) {
    picker.moved = false;
    picker.down = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = 'crosshair';
    return;
  }
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
  if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && touches.size >= 2) {
    if (!original) return;
    const now = pinchState();
    if (viewZoom.zoom > 1 || viewSelect.value === 'preview') {
      const fit = fittedSize();
      viewZoom.x -= (now.x - pinch.x) / fit.w / viewZoom.zoom;
      viewZoom.y += (now.y - pinch.y) / fit.h / viewZoom.zoom;
      clampZoom();
    }
    setZoom(viewZoom.zoom * now.d / Math.max(1, pinch.d), viewUv({ clientX: now.x, clientY: now.y }));
    pinch = now;
    return;
  }
  if (picker) {
    drawLoupe(event);
    if (!event.buttons || !panFrom || !picker.down) return;
    if (Math.hypot(event.clientX - picker.down.x, event.clientY - picker.down.y) > 4) picker.moved = true;
    if (!picker.moved || viewZoom.zoom <= 1) return;
    const fit = fittedSize();
    viewZoom.x -= (event.clientX - panFrom.x) / fit.w / viewZoom.zoom;
    viewZoom.y += (event.clientY - panFrom.y) / fit.h / viewZoom.zoom;
    panFrom = { x: event.clientX, y: event.clientY };
    clampZoom();
    presentCurrent();
    return;
  }
  if (!event.buttons || !panFrom) return;
  const preview = viewSelect.value === 'preview';
  const lightDrag = event.buttons === 2 || event.shiftKey;
  const dx = event.clientX - panFrom.x;
  const dy = event.clientY - panFrom.y;
  if (preview && event.buttons === 1 && !event.shiftKey && !event.ctrlKey) {
    turnPreview(dx * 0.01, dy * 0.01);
    panFrom = { x: event.clientX, y: event.clientY };
    presentCurrent();
    return;
  }
  const movePreview = preview && (event.buttons === 4 || (event.buttons === 1 && event.ctrlKey));
  if (movePreview || (!preview && viewZoom.zoom > 1 && event.buttons === 1)) {
    const fit = fittedSize();
    viewZoom.x -= dx / fit.w / viewZoom.zoom;
    viewZoom.y += dy / fit.h / viewZoom.zoom;
    panFrom = { x: event.clientX, y: event.clientY };
    clampZoom();
    presentCurrent();
    return;
  }
  if (!preview || !lightDrag) return;
  setSun(sunAngle.az + dx * 0.5, sunAngle.el - dy * 0.3);
  panFrom = { x: event.clientX, y: event.clientY };
});
function endPan(event) {
  touches.delete(event.pointerId);
  if (touches.size < 2) pinch = null;
  if (touches.size === 1) {
    const [rest] = touches.values();
    panFrom = { x: rest.x, y: rest.y };
    return;
  }
  panFrom = null;
  if (picker && event.type === 'pointerup' && picker.down && !picker.moved) {
    applyPick(event);
    return;
  }
  canvas.style.cursor = picker ? 'crosshair' : (viewZoom.zoom > 1 ? 'grab' : '');
}
canvas.addEventListener('pointerup', endPan);
canvas.addEventListener('pointercancel', endPan);
canvas.addEventListener('dblclick', () => {
  if (!original) return;
  if (viewSelect.value === 'preview') {
    previewRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    viewZoom.x = 0.5;
    viewZoom.y = 0.5;
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

adjustShape.addEventListener('input', () => { adjustFrame = ''; refreshEditor(); });
document.getElementById('adjust-fit').addEventListener('click', () => { adjustFrame = ''; refreshEditor(); });
document.getElementById('apply-crop').addEventListener('click', () => {
  if (!original) return;
  const frame = cropFrame();
  if (frame.x < 0.001 && frame.y < 0.001 && frame.w > 0.999 && frame.h > 0.999) return;
  remember();
  original = cropCanvas(original, frame);
  photoBytes = null;
  photoName = null;
  slotImages.albedo = original;
  Object.keys(slotImages).forEach((name) => {
    if (name !== 'albedo' && slotImages[name]) slotImages[name] = cropCanvas(slotImages[name], frame);
  });
  lights.forEach((light) => { light.image = cropCanvas(light.image, frame); });
  const maskInput = document.getElementById('mask-file');
  if (maskInput._image) maskInput._image = cropCanvas(maskInput._image, frame);
  adjustFrame = '';
  commit();
  schedule();
  drawLights();
  refreshEditor();
});

document.getElementById('apply-rotate').addEventListener('click', () => {
  if (!original || !fixAngle()) return;
  remember();
  original = rotateFill(original, fixAngle());
  photoBytes = null;
  photoName = null;
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
  if (!repeatInfo) { note.textContent = text('ui.materialWizard.notes.repeatNone'); return; }
  note.textContent = text('ui.materialWizard.notes.repeat', { x: repeatInfo.periodX, y: repeatInfo.periodY, w: repeatInfo.cropW, h: repeatInfo.cropH });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text('ui.materialWizard.tile.useCrop');
  button.addEventListener('click', () => {
    remember();
    const w = repeatInfo.cropW / repeatSize.w;
    const h = repeatInfo.cropH / repeatSize.h;
    document.querySelector('[data-param="cropShape"]').value = 'free';
    document.querySelector('[data-param="tileOn"]').checked = true;
    cropInput.value = frameString({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
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
  photoBytes = null;
  photoName = null;
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
    row.innerHTML = '<span>' + text('ui.materialWizard.maps.light', { n: index + 1 }) + '</span>';
    const az = document.createElement('input');
    az.type = 'number';
    az.value = light.az;
    az.title = text('ui.materialWizard.maps.azimuth');
    az.addEventListener('focus', () => remember());
    az.addEventListener('input', () => { light.az = num(az.value, 0); });
    az.addEventListener('change', () => { light.az = num(az.value, 0); commit(); });
    const el = document.createElement('input');
    el.type = 'number';
    el.value = light.el;
    el.title = text('ui.materialWizard.maps.elevation');
    el.addEventListener('focus', () => remember());
    el.addEventListener('input', () => { light.el = num(el.value, 45); });
    el.addEventListener('change', () => { light.el = num(el.value, 45); commit(); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = text('ui.materialWizard.maps.remove');
    remove.addEventListener('click', () => { remember(); lights.splice(index, 1); commit(); drawLights(); });
    row.appendChild(az);
    row.appendChild(el);
    row.appendChild(remove);
    host.appendChild(row);
  });
}

document.getElementById('solve-lights').addEventListener('click', () => {
  if (lights.length < 3) {
    warningsEl.textContent = text('ui.materialWizard.notes.lights');
    return;
  }
  remember();
  const w = 256;
  const h = 256;
  const images = lights.map((light) => imageDataOf(light.image, w, h).data);
  const solved = solveLights(images, lights.map((light) => ({ az: light.az, el: light.el })), w, h);
  original = canvasFromRGBA(solved.albedo, w, h);
  photoBytes = null;
  photoName = null;
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

function mapPng(fileName, image) {
  return (fileName.endsWith('.dataR.png') ? grayPngBytes : pngBytes)(image.rgba, image.w, image.h);
}

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
  const shapedOpacity = params.opacityEdge > 0 || params.opacityPatch > 0 || params.opacityCrack > 0 || params.zones.some((zone) => zone.opacity < 1);
  if (params.profile === 'road' || params.opacityMode === 'load' || shapedOpacity) {
    names.push(['opacity', params.name + '_o.dataR.png']);
  }
  const { size, images } = await atOutputSize((at) => ({
    size: at,
    images: names.map(([key]) => engine.readMap(key)),
  }));
  const files = [];
  for (let i = 0; i < names.length; i++) {
    files.push({ name: prefix + names[i][1], data: await mapPng(names[i][1], images[i]) });
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
      data: new TextEncoder().encode(text('ui.materialWizard.notes.lengthFile', { length: length.toFixed(3) })),
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
  button.innerHTML = '<i class="fa-solid fa-download"></i> <span data-copy="ui.materialWizard.slots.' + slot + '">' + text('ui.materialWizard.slots.' + slot) + '</span>';
  saveHost.appendChild(button);
});
document.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-save]');
  if (!button || !original) return;
  const [key, suffix] = SAVE[button.dataset.save];
  const image = await atOutputSize(() => engine.readMap(key)).catch(() => null);
  if (!image) return;
  downloadBytes(await mapPng(suffix, image), readParams().name + suffix, 'image/png');
});

document.getElementById('download').addEventListener('click', async () => {
  if (!original) return;
  const files = await filesForCurrent('');
  downloadBytes(await zipStore(files), readParams().name + '.zip', 'application/zip');
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
    li.textContent = text('ui.materialWizard.notes.batchLine', { name: group.base, files: Object.keys(group.files).join(', ') });
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
    li.textContent = text('ui.materialWizard.notes.batchWork', { name: group.base });
    list.appendChild(li);
    try {
      const colorFile = group.files.albedo;
      if (!colorFile) throw new Error('no color image');
      original = await loadImage(colorFile);
      photoBytes = null;
      photoName = null;
      document.querySelector('[data-param="name"]').value = group.base.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+/, '') || 'm_material';
      for (const [name] of SLOTS) {
        slotImages[name] = null;
        document.querySelector('[data-slot-mode="' + name + '"]').value = name === 'albedo' ? 'load' : 'generate';
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
      li.textContent = text('ui.materialWizard.notes.batchDone', { name: group.base });
    } catch (error) {
      li.textContent = text('ui.materialWizard.notes.batchFail', { name: group.base });
    }
  }
  return all;
}

document.getElementById('run-batch').addEventListener('click', async () => {
  const input = document.getElementById('batch-folder');
  if (!input.files.length) return;
  const all = await runGroups(input.files, null);
  if (all.length) downloadBytes(await zipStore(all), 'material-wizard-batch.zip', 'application/zip');
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

function imagePngBytes(image) {
  const c = paint(image, image.width, image.height);
  return new Promise((resolve) => c.toBlob(async (blob) => {
    c.width = c.height = 0;
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, 'image/png'));
}

const GRAY_MAPS = new Set(['height', 'roughness', 'metallic', 'ao', 'opacity']);

async function imageGrayBytes(image) {
  const c = paint(image, image.width, image.height);
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  return grayPngBytes(data.data, data.width, data.height);
}

async function projectBytes() {
  const values = readPreset();
  document.querySelectorAll('[data-param]').forEach((el) => {
    if (PRESET_SKIP.has(el.dataset.param)) values['p:' + el.dataset.param] = controlValue(el);
  });
  const names = {};
  document.querySelectorAll('[data-file-name]').forEach((el) => { names[el.dataset.fileName] = el.textContent; });
  const mask = document.getElementById('mask-file')._image || null;
  const maps = SLOTS.map(([name]) => name).filter((name) => name !== 'albedo' && slotImages[name]);
  const photo = photoBytes && photoName ? photoName : 'photo.png';
  const session = {
    materialWizardSession: 1,
    version: VERSION,
    photo,
    values,
    names,
    maps,
    whiteBalance,
    lightColors,
    sun: [sunAngle.az, sunAngle.el],
    lights: lights.map((light) => ({ az: light.az, el: light.el })),
    mask: !!mask,
  };
  const files = [{ name: 'session.json', data: new TextEncoder().encode(JSON.stringify(session)) }];
  files.push({ name: photo, data: photoBytes || await imagePngBytes(original) });
  for (const name of maps) {
    const image = slotImages[name];
    files.push({ name: 'maps/' + name + '.png', data: GRAY_MAPS.has(name) ? await imageGrayBytes(image) : await imagePngBytes(image) });
  }
  for (let i = 0; i < lights.length; i++) files.push({ name: 'lights/' + i + '.png', data: await imagePngBytes(lights[i].image) });
  if (mask) files.push({ name: 'mask.png', data: await imageGrayBytes(mask) });
  return zipStore(files);
}

async function decodeProject(project) {
  const names = [project.photo];
  for (const name of project.session.maps || []) names.push('maps/' + name + '.png');
  for (let i = 0; i < (project.session.lights || []).length; i++) names.push('lights/' + i + '.png');
  if (project.session.mask) names.push('mask.png');
  const images = [];
  try {
    for (const name of names) {
      const bitmap = await createImageBitmap(new Blob([project.files[name]]));
      if (!bitmap.width || !bitmap.height) throw new Error('empty image');
      images.push(bitmap);
    }
  } catch (error) {
    images.forEach((image) => image.close());
    throw error;
  }
  return images;
}

async function verifiedProject() {
  const bytes = await projectBytes();
  const images = await decodeProject(await readProject(bytes));
  images.forEach((image) => image.close());
  return bytes;
}

let projectHandle = null;
const PROJECT_TYPE = { 'application/x-material-wizard': ['.mwz'] };
const IMAGE_TYPES = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/avif': ['.avif'], 'image/bmp': ['.bmp'], 'image/gif': ['.gif'] };

async function saveProject(as) {
  if (!original) return;
  const name = readParams().name + '.mwz';
  let handle = projectHandle;
  try {
    if (window.showSaveFilePicker && (as || !handle)) {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: text('ui.materialWizard.menu.projectType'), accept: PROJECT_TYPE }] });
    }
    const bytes = await verifiedProject();
    if (!window.showSaveFilePicker) {
      downloadBytes(bytes, name, 'application/zip');
      return;
    }
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    projectHandle = handle;
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.warn('project save failed', error);
    warningsEl.textContent = text('ui.materialWizard.notes.saveFailed');
  }
}

async function openAny(file, handle) {
  if (/\.mwz$/i.test(file.name)) {
    if (await openProject(file)) projectHandle = handle || null;
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    useImage(await loadImage(new Blob([bytes], { type: file.type || 'image/png' })), file, bytes);
  }
}

const openAnyInput = document.getElementById('open-any');
openAnyInput.addEventListener('change', () => {
  const file = openAnyInput.files[0];
  openAnyInput.value = '';
  if (file) openAny(file);
});

async function pickAndOpen() {
  if (!window.showOpenFilePicker) { openAnyInput.click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ types: [{ description: text('ui.materialWizard.menu.openType'), accept: { ...PROJECT_TYPE, ...IMAGE_TYPES } }] });
    await openAny(await handle.getFile(), handle);
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('open failed', error);
  }
}

if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const [handle] = params.files || [];
    if (handle) await openAny(await handle.getFile(), handle);
  });
}

async function openProject(file) {
  try {
    const project = await readProject(new Uint8Array(await file.arrayBuffer()));
    const images = await decodeProject(project);
    const session = project.session;
    const photo = images[0];
    let cursor = 1;
    const maps = {};
    for (const name of session.maps || []) maps[name] = images[cursor++];
    const lightImages = [];
    for (let i = 0; i < (session.lights || []).length; i++) lightImages.push(images[cursor++]);
    const mask = session.mask ? images[cursor] : null;
    restoring = true;
    original = photo;
    photoBytes = project.files[project.photo];
    photoName = project.photo;
    sessionNote = versionNewer(session.version) ? text('ui.materialWizard.notes.newerFile', { v: session.version }) : '';
    Object.keys(slotImages).forEach((key) => delete slotImages[key]);
    Object.assign(slotImages, maps, { albedo: photo });
    whiteBalance = session.whiteBalance || null;
    lightColors = (session.lightColors || []).filter((hex) => /^#[0-9a-f]{6}$/i.test(hex)).slice(0, LIGHT_COLORS_MAX);
    renderLightColors();
    lights = (session.lights || []).map((light, i) => ({ image: lightImages[i], az: light.az, el: light.el }));
    document.getElementById('mask-file')._image = mask;
    writePreset(session.values || {});
    document.querySelectorAll('[data-file-name]').forEach((el) => {
      el.textContent = (session.names || {})[el.dataset.fileName] || text('ui.materialWizard.maps.choose');
    });
    SLOTS.forEach(([name]) => syncSlot(name));
    drawLights();
    restoring = false;
    held = null;
    undoStack.length = 0;
    redoStack.length = 0;
    syncHistoryButtons();
    if (session.sun) {
      sunAngle.az = session.sun[0];
      sunAngle.el = session.sun[1];
      drawSunDial();
    }
    schedule();
    refreshEditor();
    return true;
  } catch (error) {
    restoring = false;
    console.warn('session open failed', error);
    warningsEl.textContent = text('ui.materialWizard.notes.badFile', { name: file.name });
    return false;
  }
}

const menuButtons = Array.from(document.querySelectorAll('[data-menu]'));
const flyoutOf = (button) => document.querySelector('[data-flyout="' + button.dataset.menu + '"]');
function closeMenus() {
  menuButtons.forEach((button) => {
    flyoutOf(button).hidden = true;
    button.setAttribute('aria-expanded', 'false');
  });
}
menuButtons.forEach((button) => button.addEventListener('click', () => {
  const flyout = flyoutOf(button);
  const open = flyout.hidden;
  closeMenus();
  if (!open) return;
  flyout.hidden = false;
  const rect = button.getBoundingClientRect();
  flyout.style.top = rect.bottom + 'px';
  flyout.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - flyout.offsetWidth)) + 'px';
  button.setAttribute('aria-expanded', 'true');
}));
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.mw-flyout, [data-menu]')) closeMenus();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeMenus();
  cancelPick();
});
document.getElementById('app-version').textContent = 'Material Wizard ' + VERSION;

let installPrompt = null;
const installItems = document.querySelectorAll('[data-install]');
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  installItems.forEach((el) => { el.hidden = false; });
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  installItems.forEach((el) => { el.hidden = true; });
});

const startSnapshot = Object.assign(takeSnapshot(), { names: {} });
const startSun = { az: sunAngle.az, el: sunAngle.el };

function newProject() {
  remember();
  applySnapshot(startSnapshot);
  projectHandle = null;
  sessionNote = '';
  adjustFrame = '';
  Object.assign(sunAngle, startSun);
  drawSunDial();
  commit();
}

const FILE_ACTIONS = {
  new: newProject,
  open: pickAndOpen,
  save: () => saveProject(false),
  saveAs: () => saveProject(true),
  export: () => document.getElementById('download').click(),
  install: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
  },
};
document.querySelector('[data-flyout="file"]').addEventListener('click', (event) => {
  const item = event.target.closest('[data-file-action]');
  if (!item) return;
  closeMenus();
  FILE_ACTIONS[item.dataset.fileAction]();
});
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  const action = key === 'o' ? 'open' : key === 's' ? (event.shiftKey ? 'saveAs' : 'save') : key === 'e' ? 'export' : null;
  if (!action) return;
  event.preventDefault();
  closeMenus();
  FILE_ACTIONS[action]();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('service worker failed', error));

engine.resize(1024, 1024);
