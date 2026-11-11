import { engine } from './render.js';
import { TERRAIN_VIEW_PARAMS } from './terrain.js';
import { applySnapshot, redoStack, syncHistoryButtons, takeSnapshot, undoStack } from '../services/history.js';
import { state } from '../services/state.js';

// These describe the terrain material and the view, so both layers share them.
const SHARED = new Set(['kind', 'name', 'prefix', 'namePattern', 'folder', 'profile', 'annotation', 'alphaRef', 'tGround',
  'size', 'pot', 'previewSize', 'shape', 'layout', 'split', 'seamLines', 'alphaView', ...TERRAIN_VIEW_PARAMS]);

const layers = { detail: null, macro: null };

const stacks = { detail: { undo: [], redo: [] }, macro: { undo: [], redo: [] } };

let active = 'detail';

export function activeLayer() {
  return active;
}

export function otherLayer() {
  return active === 'detail' ? 'macro' : 'detail';
}

export function storedLayer(which) {
  return layers[which];
}

export function setStoredLayer(which, snap) {
  layers[which] = snap;
}

export function layerPhoto(which) {
  if (which === active) return state.original;
  const snap = layers[which];
  return snap && snap.original;
}

function layerSnapshot() {
  const snap = takeSnapshot();
  SHARED.forEach((key) => delete snap.values['p:' + key]);
  return snap;
}

// The first visit copies the other layer's settings and leaves the photo behind.
function blankFrom(snap) {
  const names = Object.assign({}, snap.names);
  delete names.albedo;
  const slots = Object.assign({}, snap.slots);
  delete slots.albedo;
  return {
    original: null,
    photoBytes: null,
    photoName: null,
    slots,
    whiteBalance: snap.whiteBalance ? snap.whiteBalance.slice() : null,
    lightColors: snap.lightColors.slice(),
    lights: snap.lights.map((light) => ({ image: light.image, az: light.az, el: light.el })),
    mask: snap.mask,
    names,
    values: Object.assign({}, snap.values),
  };
}

function syncButtons() {
  document.querySelectorAll('#layer-seg [data-layer]').forEach((button) => {
    const on = button.dataset.layer === active;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

function parkStacks(which) {
  stacks[which] = { undo: undoStack.splice(0, undoStack.length), redo: redoStack.splice(0, redoStack.length) };
}

function unparkStacks(which) {
  const saved = stacks[which];
  undoStack.push(...saved.undo);
  redoStack.push(...saved.redo);
  stacks[which] = { undo: [], redo: [] };
  syncHistoryButtons();
}

export function setActiveLayer(name) {
  active = name === 'macro' ? 'macro' : 'detail';
  syncButtons();
}

// hold: false leaves the retained preview textures alone (export renders at its own size).
export function switchLayer(next, opts = {}) {
  if (next !== 'detail' && next !== 'macro') return;
  if (next === active) return;
  if (opts.hold !== false && state.original) engine.holdLayer(active);
  layers[active] = layerSnapshot();
  parkStacks(active);
  const previous = active;
  active = next;
  if (!layers[active]) layers[active] = blankFrom(layers[previous]);
  unparkStacks(active);
  applySnapshot(layers[active], { render: opts.render !== false });
  syncButtons();
}

export async function withLayer(which, fn) {
  const back = active;
  if (which !== back) switchLayer(which, { hold: false, render: false });
  try {
    return await fn();
  } finally {
    if (active !== back) switchLayer(back, { hold: false, render: false });
  }
}

export function clearLayers() {
  layers.detail = null;
  layers.macro = null;
  stacks.detail = { undo: [], redo: [] };
  stacks.macro = { undo: [], redo: [] };
  engine.dropHeld('detail');
  engine.dropHeld('macro');
}

export function resetLayers() {
  if (active !== 'detail') switchLayer('detail', { hold: false, render: false });
  layers.detail = null;
  layers.macro = null;
  undoStack.splice(0, undoStack.length);
  redoStack.splice(0, redoStack.length);
  stacks.detail = { undo: [], redo: [] };
  stacks.macro = { undo: [], redo: [] };
  engine.dropHeld('detail');
  engine.dropHeld('macro');
  syncButtons();
  syncHistoryButtons();
}

export function init() {
  document.getElementById('layer-seg').addEventListener('click', (event) => {
    const button = event.target.closest('[data-layer]');
    if (button) switchLayer(button.dataset.layer);
  });
  syncButtons();
}
