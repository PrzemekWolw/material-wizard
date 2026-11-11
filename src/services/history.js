import { appbar } from '../modules/phone.js';
import { renderLightColors } from '../modules/pick.js';
import { schedule } from '../modules/render.js';
import { syncSlot } from '../modules/slots.js';
import { drawLights } from '../modules/sun.js';
import { THUMB, slotThumbs, stripThumbs } from '../modules/view.js';
import { text } from './i18n.js';
import { readValues, writePreset } from './presets.js';
import { SLOTS, drop, slotImages, warningsEl, state } from './state.js';
import { imageBytes, keepSource } from '../utils/images.js';

const HISTORY_LIMIT = 30;

// Snapshots further back than this store their images as file bytes, decoded again on undo.
const KEEP_IMAGES = 3;

const HISTORY_CONTROL = '[data-param], [data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor], [data-zone], #quad, #orm-order';

export const undoStack = [];

export const redoStack = [];

export function takeSnapshot() {
  const names = {};
  document.querySelectorAll('[data-file-name]').forEach((el) => { names[el.dataset.fileName] = el.textContent; });
  return {
    original: state.original,
    slots: Object.assign({}, slotImages),
    whiteBalance: state.whiteBalance ? state.whiteBalance.slice() : null,
    lightColors: state.lightColors.slice(),
    lights: state.lights.map((light) => ({ image: light.image, az: light.az, el: light.el })),
    mask: document.getElementById('mask-file')._image || null,
    names,
    values: readValues(true),
    photoBytes: state.photoBytes,
    photoName: state.photoName,
  };
}

function sameKeys(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function sameSnapshot(a, b) {
  if (a.original !== b.original || a.mask !== b.mask) return false;
  if ((a.whiteBalance || []).join() !== (b.whiteBalance || []).join()) return false;
  if (a.lightColors.join() !== b.lightColors.join()) return false;
  if (!sameKeys(a.values, b.values) || !sameKeys(a.slots, b.slots)) return false;
  if (a.lights.length !== b.lights.length) return false;
  for (let i = 0; i < a.lights.length; i++) {
    if (a.lights[i].image !== b.lights[i].image || a.lights[i].az !== b.lights[i].az || a.lights[i].el !== b.lights[i].el) return false;
  }
  return true;
}

export function remember() {
  if (state.restoring || state.held) return;
  state.held = takeSnapshot();
}

export function commit() {
  if (state.restoring || !state.held) return;
  const now = takeSnapshot();
  if (sameSnapshot(state.held, now)) { state.held = null; return; }
  undoStack.push(state.held);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  compact(undoStack);
  state.held = null;
  redoStack.length = 0;
  syncHistoryButtons();
}

// Swaps the image references of a snapshot for { bytes }, in place once all are encoded.
async function pack(snap) {
  if (snap.packing) return;
  snap.packing = true;
  const done = new Map();
  const bytes = async (image) => {
    if (!image) return null;
    if (!done.has(image)) done.set(image, { bytes: await imageBytes(image) });
    return done.get(image);
  };
  const slots = {};
  for (const key of Object.keys(snap.slots)) slots[key] = await bytes(snap.slots[key]);
  const lights = [];
  for (const light of snap.lights) lights.push({ ...light, image: await bytes(light.image) });
  Object.assign(snap, { original: await bytes(snap.original), slots, lights, mask: await bytes(snap.mask), packed: true });
}

function compact(stack) {
  const old = stack[stack.length - 1 - KEEP_IMAGES];
  if (old) pack(old).catch((error) => console.warn('history pack failed', error));
}

// A snapshot with images again. Entries that share bytes share the decoded image.
async function unpacked(snap) {
  if (!snap.packed) return snap;
  const done = new Map();
  const image = async (entry) => {
    if (!entry) return null;
    if (!done.has(entry)) {
      const blob = new Blob([entry.bytes]);
      done.set(entry, keepSource(await createImageBitmap(blob), blob));
    }
    return done.get(entry);
  };
  const slots = {};
  for (const key of Object.keys(snap.slots)) slots[key] = await image(snap.slots[key]);
  const lights = [];
  for (const light of snap.lights) lights.push({ ...light, image: await image(light.image) });
  return { ...snap, original: await image(snap.original), slots, lights, mask: await image(snap.mask), packed: false };
}

function clearThumbs() {
  Object.keys(stripThumbs).forEach((view) => stripThumbs[view].getContext('2d').clearRect(0, 0, THUMB, THUMB));
  Object.keys(slotThumbs).forEach((name) => slotThumbs[name].getContext('2d').clearRect(0, 0, THUMB, THUMB));
}

export function applySnapshot(snap, opts) {
  state.restoring = true;
  state.original = snap.original;
  state.photoBytes = snap.photoBytes || null;
  state.photoName = snap.photoName || null;
  Object.keys(slotImages).forEach((key) => delete slotImages[key]);
  Object.assign(slotImages, snap.slots);
  state.whiteBalance = snap.whiteBalance ? snap.whiteBalance.slice() : null;
  state.lightColors = snap.lightColors.slice();
  renderLightColors();
  state.lights = snap.lights.map((light) => ({ image: light.image, az: light.az, el: light.el }));
  document.getElementById('mask-file')._image = snap.mask;
  writePreset(snap.values);
  document.querySelectorAll('[data-file-name]').forEach((el) => {
    el.textContent = snap.names[el.dataset.fileName] || text('ui.materialWizard.maps.choose');
  });
  SLOTS.forEach(([name]) => syncSlot(name));
  drawLights();
  state.restoring = false;
  if (!state.original) {
    document.getElementById('seam-note').textContent = '';
    drop.classList.remove('has-image');
    warningsEl.innerHTML = '';
    document.getElementById('scale-note').textContent = '';
    clearThumbs();
  }
  if (!opts || opts.render !== false) schedule();
}

let stepping = false;

async function step(from, to) {
  if (!from.length || stepping) return;
  stepping = true;
  try {
    state.held = null;
    const snap = await unpacked(from[from.length - 1]);
    from.pop();
    to.push(takeSnapshot());
    compact(to);
    applySnapshot(snap);
    syncHistoryButtons();
  } finally {
    stepping = false;
  }
}

export function undo() {
  return step(undoStack, redoStack);
}

export function redo() {
  return step(redoStack, undoStack);
}

export function syncHistoryButtons() {
  document.getElementById('undo').disabled = undoStack.length === 0;
  document.getElementById('redo').disabled = redoStack.length === 0;
  appbar.querySelector('[data-app="undo"]').disabled = undoStack.length === 0;
  appbar.querySelector('[data-app="redo"]').disabled = redoStack.length === 0;
}

export function init() {
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
}
