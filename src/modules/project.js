import { crc32, grayPngBytes, downloadBytes } from '../export.js';
import { VERSION, versionNewer } from '../../version.js';
import { classify } from './batch.js';
import { closeMenus, installPrompt } from './layout.js';
import { LIGHT_COLORS_MAX } from './pick.js';
import { schedule } from './render.js';
import { setSlotMode } from './slots.js';
import { drawSunDial, sunAngle } from './sun.js';
import { cropInput, currentTileView, refreshEditor, setTileView } from './tiling.js';
import { showView, viewSelect } from './view.js';
import { activeLayer, clearHistory, clearLayers, otherLayer, parkedStacks, resetLayers, setActiveLayer, setParkedStacks, setStoredLayer, storedLayer } from './layers.js';
import { applySnapshot, commit, knownEntry, redoStack, remember, syncHistoryButtons, takeSnapshot, undoStack } from '../services/history.js';
import { text } from '../services/i18n.js';
import { hideProgress, showProgress, trackOpen } from '../services/progress.js';
import { SLOTS, clearFileNote, drop, readParams, showFileNote, slotImages, state } from '../services/state.js';
import { hasSource, imageBytes, keepSource, loadImage, paint } from '../utils/images.js';
import { run } from '../services/worker.js';

const openFile = document.getElementById('open-file');

function nameFromFile(file) {
  if (!file || !file.name || /^image\.\w+$/i.test(file.name)) return '';
  return classify(file.name).base.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '');
}

export function setNameFrom(file) {
  const name = nameFromFile(file);
  if (name) document.querySelector('[data-param="name"]').value = name;
}

function photoFileName(file) {
  const ext = ((file && file.name || '').split('.').pop() || 'png').toLowerCase();
  return 'photo.' + ({ jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' }[ext] || 'png');
}

export function useImage(image, file, bytes) {
  remember();
  state.projectHandle = null;
  state.sessionNote = '';
  clearFileNote();
  SLOTS.forEach(([name]) => {
    if (name === 'albedo') return;
    delete slotImages[name];
    setSlotMode(name, 'generate');
    document.querySelector('[data-file-name="' + name + '"]').textContent = text('ui.materialWizard.maps.choose');
  });
  state.original = image;
  state.photoBytes = bytes || null;
  state.photoName = bytes ? photoFileName(file) : null;
  slotImages.albedo = image;
  setSlotMode('albedo', 'load');
  document.querySelector('[data-file-name="albedo"]').textContent = file && file.name ? file.name : text('ui.materialWizard.maps.choose');
  cropInput.value = '';
  setNameFrom(file);
  commit();
  schedule();
}

const GRAY_MAPS = new Set(['height', 'roughness', 'metallic', 'ao', 'opacity']);

function layerRecord(snap) {
  return {
    photo: snap.original ? (snap.photoName || 'photo.png') : null,
    values: snap.values,
    names: snap.names,
    maps: SLOTS.map(([name]) => name).filter((name) => name !== 'albedo' && snap.slots[name]),
    whiteBalance: snap.whiteBalance,
    lightColors: snap.lightColors,
    lights: (snap.lights || []).map((light) => ({ az: light.az, el: light.el })),
    mask: !!snap.mask,
  };
}

// The photo, maps, lights and mask of one layer, under dir ('' for the open layer).
function putLayer(table, snap, dir, photo) {
  if (!snap.original) return;
  table.put(snap.original, dir + photo, false, snap.photoBytes);
  SLOTS.forEach(([name]) => {
    if (name !== 'albedo' && snap.slots[name]) table.put(snap.slots[name], dir + 'maps/' + name + '.png', GRAY_MAPS.has(name));
  });
  snap.lights.forEach((light, i) => table.put(light.image, dir + 'lights/' + i + '.png'));
  if (snap.mask) table.put(snap.mask, dir + 'mask.png', true);
}

// Every image of a save, encoded once. Images of the current state get their fixed names (put),
// history images reuse those or get history/img/N.png (add).
function imageTable() {
  const names = new Map();
  const jobs = [];
  return {
    jobs,
    put(source, name, gray, data) {
      if (!names.has(source)) names.set(source, name);
      jobs.push({ name, source, gray: !!gray, data });
    },
    add(source, gray) {
      if (!source) return;
      if (names.has(source)) return;
      const name = 'history/img/' + jobs.length + '.png';
      names.set(source, name);
      jobs.push({ name, source, gray: !!gray });
    },
    nameOf: (source) => source ? names.get(source) || null : null,
  };
}

// Reuses the bytes history already encoded, so a step and the current state store the same entry.
async function imageData(image, gray) {
  const known = knownEntry(image);
  if (known && (!gray || hasSource(image))) return (await known).bytes;
  return storedBytes(image, gray);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Packed history entries already hold their bytes. A history image whose bytes are already stored is
// left out and points at that entry instead.
async function encodeTable(table, report) {
  const files = [];
  const alias = new Map();
  const seen = new Map();
  for (let i = 0; i < table.jobs.length; i++) {
    report(i, table.jobs.length);
    const job = table.jobs[i];
    const data = job.data || job.source.bytes || await imageData(job.source, job.gray);
    const key = data.length + ':' + crc32(data);
    const same = (seen.get(key) || []).find((file) => sameBytes(file.data, data));
    if (same && job.name.startsWith('history/')) {
      alias.set(job.name, same.name);
      continue;
    }
    const file = { name: job.name, data };
    seen.set(key, (seen.get(key) || []).concat(file));
    files.push(file);
  }
  report(table.jobs.length, table.jobs.length);
  return { files, alias };
}

// Snapshots in a stack can be packed while a save awaits, so it works on copies.
function frozen(snap) {
  return { ...snap, slots: { ...snap.slots }, lights: snap.lights.map((light) => ({ ...light })) };
}

function addStep(table, snap) {
  table.add(snap.original);
  Object.keys(snap.slots).forEach((key) => table.add(snap.slots[key], GRAY_MAPS.has(key)));
  snap.lights.forEach((light) => table.add(light.image));
  table.add(snap.mask, true);
}

function stepRecord(snap, nameOf) {
  const slots = {};
  Object.keys(snap.slots).forEach((key) => { if (snap.slots[key]) slots[key] = nameOf(snap.slots[key]); });
  return {
    photo: nameOf(snap.original),
    photoName: snap.photoName || null,
    slots,
    lights: snap.lights.map((light) => ({ image: nameOf(light.image), az: light.az, el: light.el })),
    mask: nameOf(snap.mask),
    whiteBalance: snap.whiteBalance || null,
    lightColors: snap.lightColors || [],
    names: snap.names || {},
    values: snap.values || {},
  };
}

// Rebuilds saved steps as packed snapshots: nothing is decoded until a step is undone to.
function historyFrom(history, files) {
  const entries = new Map();
  const entry = (name) => {
    if (name == null) return null;
    if (!entries.has(name)) entries.set(name, { bytes: files[name] });
    return entries.get(name);
  };
  const step = (saved) => {
    const slots = {};
    Object.keys(saved.slots || {}).forEach((key) => { slots[key] = entry(saved.slots[key]); });
    return {
      original: entry(saved.photo),
      photoBytes: saved.photoName && saved.photo ? files[saved.photo] : null,
      photoName: saved.photoName || null,
      slots,
      whiteBalance: saved.whiteBalance || null,
      lightColors: (saved.lightColors || []).slice(0, LIGHT_COLORS_MAX),
      lights: (saved.lights || []).map((light) => ({ image: entry(light.image), az: light.az, el: light.el })),
      mask: entry(saved.mask),
      names: saved.names || {},
      values: saved.values || {},
      packed: true,
      packing: true,
    };
  };
  const pair = (saved) => ({ undo: (saved.undo || []).map(step), redo: (saved.redo || []).map(step) });
  const layers = {};
  Object.keys(history.layers || {}).forEach((which) => { layers[which] = pair(history.layers[which]); });
  return { ...pair(history), layers };
}

function viewState() {
  const tab = document.querySelector('#tabs [data-tab].is-active');
  return { view: viewSelect.value, tab: tab ? tab.dataset.tab : 'maps', tileView: currentTileView() };
}

function restoreView(view) {
  if (!view) return;
  const tab = [...document.querySelectorAll('#tabs [data-tab]')].find((el) => el.dataset.tab === view.tab);
  if (tab && !tab.classList.contains('is-active')) tab.click();
  if ([...viewSelect.options].some((option) => option.value === view.view)) showView(view.view);
  setTileView(view.tileView);
}

async function imageFrom(bytes) {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);
  if (!bitmap.width || !bitmap.height) throw new Error('empty image');
  return keepSource(bitmap, blob);
}

async function layerSnapshotFrom(layer, files, which) {
  const snap = {
    original: null,
    photoBytes: null,
    photoName: null,
    slots: {},
    whiteBalance: layer.whiteBalance || null,
    lightColors: layer.lightColors || [],
    lights: [],
    mask: null,
    names: layer.names || {},
    values: layer.values || {},
  };
  if (!layer.photo) return snap;
  const dir = 'layers/' + which + '/';
  snap.photoName = layer.photo;
  snap.photoBytes = files[dir + layer.photo];
  snap.original = await imageFrom(snap.photoBytes);
  snap.slots.albedo = snap.original;
  for (const name of layer.maps || []) snap.slots[name] = await imageFrom(files[dir + 'maps/' + name + '.png']);
  for (let i = 0; i < (layer.lights || []).length; i++) {
    const light = layer.lights[i];
    snap.lights.push({ image: await imageFrom(files[dir + 'lights/' + i + '.png']), az: light.az, el: light.el });
  }
  if (layer.mask) snap.mask = await imageFrom(files[dir + 'mask.png']);
  return snap;
}

// Loaded files are stored as is (entries keep their .png name for older readers, whatever the format).
// Changed gray maps are stored as 8-bit gray PNGs.
async function storedBytes(image, gray) {
  if (!gray || hasSource(image)) return imageBytes(image);
  const c = paint(image, image.width, image.height);
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  return grayPngBytes(data.data, data.width, data.height);
}

// Everything is read up front, so edits made while a slow save runs cannot end up half in the file.
async function projectBytes(progress) {
  const snap = takeSnapshot();
  const sun = [sunAngle.az, sunAngle.el];
  const view = viewState();
  const active = activeLayer();
  const other = otherLayer();
  const otherSnap = storedLayer(other);
  const parked = otherSnap && parkedStacks(other);
  const stacks = {
    undo: undoStack.map(frozen),
    redo: redoStack.map(frozen),
    other: parked && (parked.undo.length || parked.redo.length) ? { undo: parked.undo.map(frozen), redo: parked.redo.map(frozen) } : null,
  };
  const photo = snap.photoBytes && snap.photoName ? snap.photoName : 'photo.png';
  const table = imageTable();
  putLayer(table, snap, '', photo);
  if (otherSnap) putLayer(table, otherSnap, 'layers/' + other + '/', layerRecord(otherSnap).photo);
  [stacks.undo, stacks.redo, stacks.other ? stacks.other.undo : [], stacks.other ? stacks.other.redo : []]
    .forEach((list) => list.forEach((step) => addStep(table, step)));

  const { files, alias } = await encodeTable(table, (done, total) => progress('encoding', 0.7 * done / Math.max(1, total), { n: done, total }));
  const nameOf = (source) => {
    const name = table.nameOf(source);
    return name && (alias.get(name) || name);
  };
  const session = {
    materialWizardSession: 1,
    version: VERSION,
    photo,
    values: snap.values,
    names: snap.names,
    maps: SLOTS.map(([name]) => name).filter((name) => name !== 'albedo' && snap.slots[name]),
    whiteBalance: snap.whiteBalance,
    lightColors: snap.lightColors,
    sun,
    lights: snap.lights.map((light) => ({ az: light.az, el: light.el })),
    mask: !!snap.mask,
    view,
  };
  if (otherSnap || active !== 'detail') {
    session.layers = { active };
    if (otherSnap) session.layers[other] = layerRecord(otherSnap);
  }
  if (stacks.undo.length || stacks.redo.length || stacks.other) {
    const steps = (list) => list.map((step) => stepRecord(step, nameOf));
    session.history = { v: 1, undo: steps(stacks.undo), redo: steps(stacks.redo) };
    if (stacks.other) session.history.layers = { [other]: { undo: steps(stacks.other.undo), redo: steps(stacks.other.redo) } };
  }
  files.unshift({ name: 'session.json', data: new TextEncoder().encode(JSON.stringify(session)) });
  progress('zipping', 0.7);
  return run('zip', { files });
}

async function decodeProject(project, report) {
  const names = [project.photo];
  for (const name of project.session.maps || []) names.push('maps/' + name + '.png');
  for (let i = 0; i < (project.session.lights || []).length; i++) names.push('lights/' + i + '.png');
  if (project.session.mask) names.push('mask.png');
  const images = [];
  try {
    for (let i = 0; i < names.length; i++) {
      if (report) report(i, names.length);
      const blob = new Blob([project.files[names[i]]]);
      const bitmap = await createImageBitmap(blob);
      if (!bitmap.width || !bitmap.height) throw new Error('empty image');
      images.push(keepSource(bitmap, blob));
    }
    if (report) report(names.length, names.length);
  } catch (error) {
    images.forEach((image) => image.close());
    throw error;
  }
  return images;
}

async function verifiedProject(progress) {
  const bytes = await projectBytes(progress);
  progress('verifying', 0.8);
  const project = await run('readProject', { bytes });
  if (project.historyDropped) throw new Error('bad history');
  const images = await decodeProject(project);
  images.forEach((image) => image.close());
  return bytes;
}

const appSave = document.querySelector('[data-app="save"]');

let saving = false;

function setSaving(on) {
  saving = on;
  document.querySelector('[data-file-action="save"]').disabled = on;
  document.querySelector('[data-file-action="saveAs"]').disabled = on;
  appSave.setAttribute('aria-busy', String(on));
}

// fraction is the whole save, 0 to 1. busy shows the racing dots for the stages that cannot count.
function showStatus(fraction, label, busy) {
  showProgress(fraction, label, busy);
  appSave.style.setProperty('--mw-save', String(fraction));
}

function hideStatus(delay) {
  hideProgress(delay);
}

function saveProgress(stage, fraction, vars) {
  showStatus(fraction, text('ui.materialWizard.save.' + stage, vars), stage !== 'encoding');
}

function saveFailed(key, error) {
  console.warn('project save failed', error);
  hideStatus(0);
  showFileNote(text('ui.materialWizard.notes.' + key));
}

// The save dialog creates the file immediately, empty. This is that file until a checked write
// replaces it, so a failed save or a closed tab can delete it instead of leaving 0 bytes.
let uncommitted = null;

async function fileSize(handle) {
  if (!handle || typeof handle.getFile !== 'function') return -1;
  try { return (await handle.getFile()).size; }
  catch (error) { return -1; }
}

// A 0-byte project is what "could not be read" comes from. Drop it when the handle allows.
async function removeIfEmpty(handle) {
  if (!handle || typeof handle.getFile !== 'function' || typeof handle.remove !== 'function') return;
  try {
    if ((await handle.getFile()).size === 0) await handle.remove();
  } catch (error) {
    console.warn('empty project left in place', error);
  }
}

// Copies the bytes first, so a buffer detached while the stream opens cannot be written as empty.
// The file is only kept when its size matches that copy.
async function commitProject(handle, bytes) {
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  let writable = null;
  try {
    writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    writable = null;
  } catch (error) {
    if (writable && typeof writable.abort === 'function') await writable.abort().catch(() => {});
    throw error;
  }
  if (typeof handle.getFile !== 'function') return;
  if ((await handle.getFile()).size !== data.byteLength) throw new Error('short write');
}

// A handle from Open or the launch queue may only have read access. Asking needs the user's click,
// so it runs before the slow encoding.
async function writeAllowed(handle) {
  if (!handle.queryPermission) return true;
  try {
    const mode = { mode: 'readwrite' };
    return await handle.queryPermission(mode) === 'granted' || await handle.requestPermission(mode) === 'granted';
  } catch (error) {
    console.warn('write permission failed', error);
    return false;
  }
}

const PROJECT_TYPE = { 'application/x-material-wizard': ['.mwz'] };

const IMAGE_TYPES = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/avif': ['.avif'], 'image/bmp': ['.bmp'], 'image/gif': ['.gif'] };

// With the File System Access API, Save writes back to the open file and Save As always asks.
// Without it both download, so Save As is hidden.
export async function saveProject(as) {
  if (!state.original || saving) return;
  const name = readParams().name + '.mwz';
  const picker = !!window.showSaveFilePicker;
  let handle = state.projectHandle;
  setSaving(true);
  try {
    try {
      if (picker && (as || !handle)) {
        handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: text('ui.materialWizard.menu.projectType'), accept: PROJECT_TYPE }] });
        if (await fileSize(handle) === 0) uncommitted = handle;
      } else if (picker && !await writeAllowed(handle)) {
        saveFailed('saveWriteFailed', new Error('no write permission'));
        return;
      }
    } catch (error) {
      if (error.name !== 'AbortError') saveFailed('saveWriteFailed', error);
      return;
    }
    saveProgress('encoding', 0, { n: 0, total: 0 });
    let bytes;
    try {
      bytes = await verifiedProject(saveProgress);
    } catch (error) {
      saveFailed('saveFailed', error);
      return;
    }
    if (!bytes || bytes.byteLength === 0) {
      saveFailed('saveFailed', new Error('empty project'));
      return;
    }
    saveProgress('writing', 0.9);
    if (!picker) {
      downloadBytes(bytes, name, 'application/x-material-wizard');
    } else {
      try {
        await commitProject(handle, bytes);
      } catch (error) {
        saveFailed('saveWriteFailed', error);
        await removeIfEmpty(handle);
        return;
      }
      state.projectHandle = handle;
    }
    if (uncommitted === handle) uncommitted = null;
    clearFileNote();
    showStatus(1, text('ui.materialWizard.save.saved', { name: picker ? handle.name : name }), false);
    hideStatus(2500);
  } finally {
    if (uncommitted && uncommitted === handle) {
      const empty = uncommitted;
      uncommitted = null;
      await removeIfEmpty(empty);
    }
    setSaving(false);
  }
}

async function takePhoto(file) {
  try {
    await trackOpen(file, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      useImage(await loadImage(new Blob([bytes], { type: file.type || 'image/png' })), file, bytes);
    });
  } catch (error) {
    console.warn('open failed', error);
    showFileNote(text('ui.materialWizard.notes.badFile', { name: file.name }));
  }
}

async function openAny(file, handle) {
  if (/\.mwz$/i.test(file.name)) {
    if (await openProject(file)) state.projectHandle = handle || null;
  } else await takePhoto(file);
}

const openAnyInput = document.getElementById('open-any');

export async function pickAndOpen() {
  if (!window.showOpenFilePicker) { openAnyInput.click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ types: [{ description: text('ui.materialWizard.menu.openType'), accept: { ...PROJECT_TYPE, ...IMAGE_TYPES } }] });
    await openAny(await handle.getFile(), handle);
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('open failed', error);
  }
}

async function openProject(file) {
  try {
    showProgress(0.05, text('ui.materialWizard.progress.reading', { name: file.name }), true);
    const bytes = new Uint8Array(await file.arrayBuffer());
    showProgress(0.25, text('ui.materialWizard.progress.opening', { name: file.name }), true);
    const project = await run('readProject', { bytes }, { transfer: [bytes.buffer] });
    const images = await decodeProject(project, (done, total) => {
      showProgress(0.25 + 0.65 * done / Math.max(1, total), text('ui.materialWizard.progress.decoding', { n: done, total }), false);
    });
    const session = project.session;
    const photo = images[0];
    let cursor = 1;
    const maps = {};
    for (const name of session.maps || []) maps[name] = images[cursor++];
    const lightImages = [];
    for (let i = 0; i < (session.lights || []).length; i++) lightImages.push(images[cursor++]);
    const mask = session.mask ? images[cursor] : null;
    const inactive = session.layers && ['detail', 'macro'].find((name) => name !== (session.layers.active || 'detail') && session.layers[name]);
    const inactiveSnap = inactive ? await layerSnapshotFrom(session.layers[inactive], project.files, inactive) : null;
    const notes = [];
    if (versionNewer(session.version)) notes.push(text('ui.materialWizard.notes.newerFile', { v: session.version }));
    if (project.historyDropped) notes.push(text('ui.materialWizard.notes.historyDropped'));
    state.sessionNote = notes.join(' ');
    clearFileNote();
    const history = project.history ? historyFrom(project.history, project.files) : null;
    clearLayers();
    applySnapshot({
      original: photo,
      photoBytes: project.files[project.photo],
      photoName: project.photo,
      slots: Object.assign(maps, { albedo: photo }),
      whiteBalance: session.whiteBalance || null,
      lightColors: (session.lightColors || []).slice(0, LIGHT_COLORS_MAX),
      lights: (session.lights || []).map((light, i) => ({ image: lightImages[i], az: light.az, el: light.el })),
      mask,
      values: session.values || {},
      names: session.names || {},
    });
    state.held = null;
    undoStack.length = 0;
    redoStack.length = 0;
    if (history) {
      undoStack.push(...history.undo);
      redoStack.push(...history.redo);
    }
    syncHistoryButtons();
    if (session.sun) {
      sunAngle.az = session.sun[0];
      sunAngle.el = session.sun[1];
      drawSunDial();
    }
    if (inactiveSnap) {
      setStoredLayer(inactive, inactiveSnap);
      const parked = history && history.layers[inactive];
      if (parked) setParkedStacks(inactive, parked.undo, parked.redo);
    }
    setActiveLayer((session.layers && session.layers.active) || 'detail');
    schedule();
    restoreView(session.view);
    refreshEditor();
    showProgress(1, text('ui.materialWizard.progress.opened', { name: file.name }), false);
    hideProgress(1600);
    return true;
  } catch (error) {
    console.warn('session open failed', error);
    hideProgress(0);
    showFileNote(text('ui.materialWizard.notes.badFile', { name: file.name }));
    return false;
  }
}

let startSnapshot = null;

let startSun = null;

export function captureStart() {
  startSnapshot = Object.assign(takeSnapshot(), { names: {} });
  startSun = { az: sunAngle.az, el: sunAngle.el };
}

function newProject() {
  resetLayers();
  remember();
  applySnapshot(startSnapshot);
  state.projectHandle = null;
  state.sessionNote = '';
  clearFileNote();
  state.adjustFrame = '';
  Object.assign(sunAngle, startSun);
  drawSunDial();
  commit();
}

const FILE_ACTIONS = {
  new: newProject,
  open: pickAndOpen,
  save: () => saveProject(false),
  saveAs: () => saveProject(true),
  clearHistory,
  export: () => document.getElementById('download').click(),
  install: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
  },
};

export function init() {
  document.querySelector('[data-file-action="saveAs"]').hidden = !window.showSaveFilePicker;
  window.addEventListener('pagehide', () => {
    const empty = uncommitted;
    uncommitted = null;
    if (!empty || typeof empty.getFile !== 'function' || typeof empty.remove !== 'function') return;
    empty.getFile().then((file) => { if (file.size === 0) return empty.remove(); }).catch(() => {});
  });
  document.getElementById('open-photo').addEventListener('click', () => openFile.click());
  drop.addEventListener('click', () => { if (!state.original) openFile.click(); });
  openFile.addEventListener('change', async () => {
    const file = openFile.files[0];
    openFile.value = '';
    if (file) await takePhoto(file);
  });

  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) await takePhoto(file);
  });
  window.addEventListener('paste', async (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        await takePhoto(item.getAsFile());
        break;
      }
    }
  });
  openAnyInput.addEventListener('change', () => {
    const file = openAnyInput.files[0];
    openAnyInput.value = '';
    if (file) openAny(file);
  });

  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const [handle] = params.files || [];
      if (handle) await openAny(await handle.getFile(), handle);
    });
  }

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
}
