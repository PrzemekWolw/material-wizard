import { createEngine } from '../engine/engine.js';
import { textureLengthFor } from '../export.js';
import { syncCurves } from './curve.js';
import { activeLayer } from './layers.js';
import { TERRAIN_VIEW_PARAMS, syncKind } from './terrain.js';
import { syncNamePreview } from './exporter.js';
import { syncSlot } from './slots.js';
import { refreshEditor, seamBadges, tileTabActive, tiledSet } from './tiling.js';
import { drawThumbnails, presentCurrent, presentSoon, syncViewButtons } from './view.js';
import { text } from '../services/i18n.js';
import { cancelled } from '../services/worker.js';
import { SLOTS, canvas, drop, readParams, slotImages, syncResets, warningsEl, state } from '../services/state.js';
import { idOf, uploadPainted } from '../utils/images.js';
import { num, potShape, workingSize } from '../utils/sizes.js';

export let engine = createEngine(document.getElementById('view'));

let timer = 0;

let tileIdle = 0;

export function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  el.style.setProperty('--fill', ((Number(el.value) - min) / Math.max(1e-6, max - min)) * 100 + '%');
}

export function paintRanges() {
  document.querySelectorAll('input[type="range"]').forEach(paintRange);
}

// While a slow render is being dragged, frames render at DRAFT_SIZE; full size follows on release or idle.
const DRAFT_SIZE = 1024;

let draft = false;

let draftIdle = 0;

let fullMs = 0;

function queue(isDraft) {
  clearTimeout(timer);
  draft = isDraft;
  timer = setTimeout(render, 40);
}

export function schedule() {
  clearTimeout(draftIdle);
  queue(false);
  paintRanges();
}

// Sun, framing and display options only change how the maps are shown.
const VIEW_PARAMS = new Set(['shape', 'layout', 'split', 'seamLines', 'alphaView', ...TERRAIN_VIEW_PARAMS]);

// Tile drags only refresh the base-color preview. The other maps are built after the edit pauses.

const TILE_EDIT = new Set([
  'crop', 'cropShape', 'tileOn', 'tileLeft', 'tileRight', 'tileUp', 'tileDown',
  'tileBlend', 'tileSoft', 'roadRuns', 'roadWidth', 'seamLines', 'bombAmount', 'bombSeed',
  'leftA', 'leftB', 'rightA', 'rightB', 'upA', 'upB', 'downA', 'downB',
]);

const TILE_IDLE = 2000;

export function scheduleTileWork() {
  clearTimeout(tileIdle);
  tileIdle = setTimeout(() => {
    tileIdle = 0;
    schedule();
  }, TILE_IDLE);
}

export function flushTileWork() {
  if (!tileIdle) return;
  clearTimeout(tileIdle);
  tileIdle = 0;
  schedule();
}

let lastRender = null;

function loadedSlots(params) {
  return SLOTS.map(([name]) => name).filter((name) => name !== 'albedo' && slotImages[name] && params.slots[name].mode === 'load');
}

function runEngine(size, tile, params) {
  engine.setLayer(activeLayer());
  if (engine.size().w !== size.w || engine.size().h !== size.h) engine.resize(size.w, size.h);
  // Uploads only what changed: the key is the image identity and the size.
  const put = (slot, image, set) => {
    const key = image ? idOf(image) + ':' + size.w + 'x' + size.h : null;
    if (engine.uploadKey(slot) === key) return;
    if (image) uploadPainted((c) => set(c, key), image, size.w, size.h);
    else set(null, null);
  };
  put('source', tile.source, engine.setSource);
  const loaded = loadedSlots(params);
  for (const [name] of SLOTS) {
    if (name !== 'albedo') put(name, loaded.includes(name) ? tile.slots[name] : null, (c, key) => engine.setLoaded(name, c, key));
  }
  put('mask', document.getElementById('mask-file')._image, engine.setMask);
  const warnings = engine.update(params) || [];
  if (engine.lost()) throw new Error('gpu-oom');
  return warnings;
}

function outputSize(sourceImage, tile, params) {
  const wanted = tile.pow2 && params.size === 'source' ? tile.pow2 : workingSize(sourceImage, params.size, params.pot);
  return { wanted, size: capSize(wanted, engine.maxSize()) };
}

let exporting = false;

let renderWanted = false;

let outputQueue = Promise.resolve();

// Renders the layer on screen at its output size. Export calls this once per layer that has a photo.
export async function renderForExport() {
  const params = readParams();
  const tile = await tiledSet(params, loadedSlots(params));
  const { size } = outputSize(tile.source, tile, params);
  runEngine(size, tile, params);
}

// Runs fn (which may be async) with the engine at the output size, then goes back to the preview size.
// Calls run one after another, and the preview does not render until fn is done.
export function atOutputSize(fn) {
  const job = outputQueue.then(() => outputRun(fn));
  outputQueue = job.catch(() => {});
  return job;
}

async function outputRun(fn) {
  if (!(await renderReady())) throw new Error(text('ui.materialWizard.notes.gpuLost'));
  const tile = lastRender.tile;
  const params = readParams();
  const sourceImage = tile.source;
  const { wanted, size } = outputSize(sourceImage, tile, params);
  const same = engine.size().w === size.w && engine.size().h === size.h;
  let value;
  exporting = true;
  engine.setBusy(true);
  try {
    if (!same) runEngine(size, tile, params);
    value = await fn(size);
  } catch (error) {
    if (error.message === 'gpu-oom') gpuFailed(Math.max(size.w, size.h));
    throw error;
  } finally {
    exporting = false;
    engine.setBusy(false);
    if (!same || renderWanted) {
      renderWanted = false;
      await render();
    }
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

let renderToken = 0;

async function render() {
  clearTimeout(tileIdle);
  tileIdle = 0;
  if (exporting) { renderWanted = true; return false; }
  const token = ++renderToken;
  SLOTS.forEach(([name]) => syncSlot(name));
  syncCurves();
  syncKind();
  syncViewButtons();
  if (!state.original) return false;
  const params = readParams();
  syncNamePreview(params);
  const loaded = loadedSlots(params);
  let tile;
  try {
    tile = await tiledSet(params, loaded);
  } catch (error) {
    if (cancelled(error)) return false;
    console.warn('tiling failed', error);
    if (/not held/.test(error.message)) schedule();
    return false;
  }
  if (exporting) { renderWanted = true; return false; }
  if (token !== renderToken || !state.original) return false;
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
  const isDraft = draft;
  draft = false;
  const started = performance.now();
  const full = params.previewSize === 'full' ? Infinity : num(params.previewSize, 2048);
  const asked = isDraft ? Math.min(full, DRAFT_SIZE) : full;
  const work = capSize(natural, Math.min(asked, gpuLimit()));
  const notes = [];
  if (oomInfo) notes.push(text('ui.materialWizard.notes.gpuOom', oomInfo));
  if (tile.clipped.length) {
    notes.push(text('ui.materialWizard.notes.tileMargin', { sides: tile.clipped.map((side) => text('ui.materialWizard.notes.sideNames.' + side)).join(', ') }));
  }
  seamBadges(tile.scores);
  if (Math.max(work.w, work.h) + 0.5 < Math.min(Math.max(natural.w, natural.h), asked)) {
    notes.push(text('ui.materialWizard.notes.gpuCap', { w: natural.w, h: natural.h, sw: work.w, sh: work.h }));
  }
  loaded.forEach((name) => {
    const stored = slotImages[name];
    if (stored.width !== state.original.width || stored.height !== state.original.height) notes.push(text('ui.materialWizard.notes.resampled', { name }));
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
  if (!isDraft) {
    drawThumbnails();
    fullMs = performance.now() - started;
  }
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
  if (state.sessionNote) {
    const p = document.createElement('p');
    p.textContent = state.sessionNote;
    warningsEl.appendChild(p);
  }
  drop.classList.add('has-image');
  refreshEditor();
  return true;
}

async function renderReady() {
  for (let i = 0; i < 4 && !gpuLost; i++) {
    if (await render()) return true;
  }
  return false;
}

let oomCap = Infinity;

let oomInfo = null;

export let gpuLost = false;

function gpuLimit() {
  return Math.min(engine.maxSize(), oomCap);
}

function capSize(size, limit) {
  const long = Math.max(size.w, size.h);
  if (long <= limit) return size;
  const scale = limit / long;
  return { w: Math.max(1, Math.round(size.w * scale)), h: Math.max(1, Math.round(size.h * scale)) };
}

function capBelow(failedLong) {
  oomCap = Math.max(512, Math.pow(2, Math.floor(Math.log2(failedLong / 2))));
  oomInfo = { size: failedLong, cap: oomCap };
}

function gpuFailed(failedLong) {
  capBelow(failedLong);
  if (!engine.lost()) {
    engine.release();
    schedule();
  }
}

export function init() {
  document.addEventListener('input', (event) => {
    if (event.target.type === 'range') paintRange(event.target);
  });

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    gpuLost = true;
    if (oomCap === Infinity) capBelow(Math.max(engine.size().w, engine.size().h));
    warningsEl.textContent = text('ui.materialWizard.notes.gpuLost');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    engine = createEngine(canvas);
    gpuLost = false;
    schedule();
  });
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
      if (VIEW_PARAMS.has(event.target.dataset.param)) {
        presentSoon();
        refreshEditor();
        return;
      }
      if (tileTabActive() && TILE_EDIT.has(event.target.dataset.param)) {
        refreshEditor();
        scheduleTileWork();
        return;
      }
      clearTimeout(draftIdle);
      if ((event.target.type === 'range' || event.target.type === 'hidden') && fullMs > 120) {
        queue(true);
        draftIdle = setTimeout(() => queue(false), 250);
      } else queue(false);
      refreshEditor();
    }
  });
  document.body.addEventListener('change', (event) => {
    if (draft && (event.target.type === 'range' || event.target.type === 'hidden')) schedule();
  });
}
