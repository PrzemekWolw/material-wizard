import { linearToSrgb } from '../utils/color.js';
import { engine, schedule } from './render.js';
import { showView, viewSelect, viewUv, viewZoom } from './view.js';
import { zoneEl, zoneHost } from './zones.js';
import { commit, remember } from '../services/history.js';
import { fillCopy, text } from '../services/i18n.js';
import { canvas, drop, readParams, state } from '../services/state.js';

export let picker = null;

export const LIGHT_COLORS_MAX = 4;

const lightHost = document.getElementById('light-colors');

export function renderLightColors() {
  lightHost.innerHTML = '';
  state.lightColors.forEach((hex, i) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'mw-swatch';
    swatch.style.background = hex;
    swatch.dataset.lightRemove = String(i);
    swatch.dataset.title = 'ui.materialWizard.albedo.lightRemove';
    swatch.setAttribute('aria-label', text('ui.materialWizard.albedo.lightRemove'));
    lightHost.appendChild(swatch);
  });
  const picked = state.lightColors.length > 0;
  document.getElementById('light-options').classList.toggle('mw-hidden', !picked);
  document.getElementById('clear-light').classList.toggle('mw-hidden', !picked);
}

const loupe = document.getElementById('loupe');

const loupeCanvas = loupe.querySelector('canvas');

const loupeLabel = loupe.querySelector('span');

const loupeSource = document.createElement('canvas');

function srgbByte(value) {
  return Math.max(0, Math.min(255, Math.round(linearToSrgb(value / 255) * 255)));
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

export function cancelPick(restoreView = true) {
  if (!picker) return;
  const previous = picker.previousView;
  const button = picker.button;
  drop.classList.remove('mw-picking');
  button.classList.remove('mw-armed');
  fillCopy(button.parentElement || button);
  if (picker.keyboard) button.focus({ preventScroll: true });
  picker = null;
  loupe.hidden = true;
  canvas.style.cursor = viewZoom.zoom > 1 ? 'grab' : '';
  if (restoreView && viewSelect.value === 'source') showView(previous);
}

export function startPick(button, zone, light) {
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

export function drawLoupe(event) {
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

export function applyPick(event) {
  const pixel = mapPixel(event, picker.map);
  const sample = sampleMap(picker.map, pixel.x, pixel.y);
  remember();
  if (picker.light) {
    state.lightColors = state.lightColors.concat('#' + sample.hex).slice(-LIGHT_COLORS_MAX);
    renderLightColors();
  } else if (picker.zone) {
    zoneEl(picker.zone, 'color').value = '#' + sample.hex;
    fillCopy(zoneHost);
  } else {
    const yv = 0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b;
    state.whiteBalance = [yv / Math.max(0.02, sample.r), yv / Math.max(0.02, sample.g), yv / Math.max(0.02, sample.b)];
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
  state.whiteBalance = [yv / Math.max(0.02, r), yv / Math.max(0.02, g), yv / Math.max(0.02, b)];
  commit();
  schedule();
}

// Arrow keys move a keyboard loupe over the canvas (Shift for bigger steps); Enter or Space picks under it.
function pickKey(event) {
  if (!picker || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.target.closest && event.target.closest('input:not([type="button"]), select, textarea')) return;
  const step = event.shiftKey ? 32 : 8;
  const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  const rect = canvas.getBoundingClientRect();
  if (!picker.key) picker.key = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerType: 'keyboard', buttons: 0 };
  if (move) {
    event.preventDefault();
    event.stopPropagation();
    picker.keyboard = true;
    picker.key.clientX = Math.min(Math.max(picker.key.clientX + move[0], rect.left), rect.right - 1);
    picker.key.clientY = Math.min(Math.max(picker.key.clientY + move[1], rect.top), rect.bottom - 1);
    drawLoupe(picker.key);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.stopPropagation();
    picker.keyboard = true;
    applyPick(picker.key);
  } else if (event.key === 'Escape') {
    picker.keyboard = true;
  }
}

export function init() {
  loupeSource.width = loupeSource.height = 15;
  window.addEventListener('keydown', pickKey, true);

  document.getElementById('pick-white').addEventListener('click', () => startPick(document.getElementById('pick-white'), 0));
  document.getElementById('pick-light').addEventListener('click', () => startPick(document.getElementById('pick-light'), 0, true));
  document.getElementById('clear-light').addEventListener('click', () => { remember(); state.lightColors = []; renderLightColors(); commit(); schedule(); });
  lightHost.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-light-remove]');
    if (!swatch) return;
    remember();
    state.lightColors.splice(Number(swatch.dataset.lightRemove), 1);
    renderLightColors();
    commit();
    schedule();
  });
  document.getElementById('auto-white').addEventListener('click', autoWhite);
  document.getElementById('clear-white').addEventListener('click', () => { remember(); state.whiteBalance = null; commit(); schedule(); });
}
