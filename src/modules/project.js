import { grayPngBytes, downloadBytes } from '../export.js';
import { VERSION, versionNewer } from '../../version.js';
import { classify } from './batch.js';
import { closeMenus, installPrompt } from './layout.js';
import { LIGHT_COLORS_MAX } from './pick.js';
import { schedule } from './render.js';
import { setSlotMode } from './slots.js';
import { drawSunDial, sunAngle } from './sun.js';
import { cropInput, refreshEditor } from './tiling.js';
import { activeLayer, clearLayers, otherLayer, resetLayers, setActiveLayer, setStoredLayer, storedLayer } from './layers.js';
import { applySnapshot, commit, redoStack, remember, syncHistoryButtons, takeSnapshot, undoStack } from '../services/history.js';
import { text } from '../services/i18n.js';
import { readValues } from '../services/presets.js';
import { SLOTS, drop, readParams, slotImages, warningsEl, state } from '../services/state.js';
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

async function layerBytes(snap, dir) {
  if (!snap.original) return [];
  const record = layerRecord(snap);
  const files = [{ name: dir + record.photo, data: snap.photoBytes || await imageBytes(snap.original) }];
  for (const name of record.maps) files.push({ name: dir + 'maps/' + name + '.png', data: await storedBytes(snap.slots[name], GRAY_MAPS.has(name)) });
  for (let i = 0; i < snap.lights.length; i++) files.push({ name: dir + 'lights/' + i + '.png', data: await imageBytes(snap.lights[i].image) });
  if (snap.mask) files.push({ name: dir + 'mask.png', data: await storedBytes(snap.mask, true) });
  return files;
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

async function projectBytes() {
  const values = readValues(true);
  const names = {};
  document.querySelectorAll('[data-file-name]').forEach((el) => { names[el.dataset.fileName] = el.textContent; });
  const mask = document.getElementById('mask-file')._image || null;
  const maps = SLOTS.map(([name]) => name).filter((name) => name !== 'albedo' && slotImages[name]);
  const photo = state.photoBytes && state.photoName ? state.photoName : 'photo.png';
  const session = {
    materialWizardSession: 1,
    version: VERSION,
    photo,
    values,
    names,
    maps,
    whiteBalance: state.whiteBalance,
    lightColors: state.lightColors,
    sun: [sunAngle.az, sunAngle.el],
    lights: state.lights.map((light) => ({ az: light.az, el: light.el })),
    mask: !!mask,
  };
  const other = otherLayer();
  const otherSnap = storedLayer(other);
  const layerExtra = [];
  if (otherSnap || activeLayer() !== 'detail') {
    session.layers = { active: activeLayer() };
    if (otherSnap) {
      const dir = 'layers/' + other + '/';
      session.layers[other] = layerRecord(otherSnap);
      layerExtra.push(...await layerBytes(otherSnap, dir));
    }
  }
  const files = [{ name: 'session.json', data: new TextEncoder().encode(JSON.stringify(session)) }];
  files.push({ name: photo, data: state.photoBytes || await imageBytes(state.original) });
  for (const name of maps) files.push({ name: 'maps/' + name + '.png', data: await storedBytes(slotImages[name], GRAY_MAPS.has(name)) });
  for (let i = 0; i < state.lights.length; i++) files.push({ name: 'lights/' + i + '.png', data: await imageBytes(state.lights[i].image) });
  if (mask) files.push({ name: 'mask.png', data: await storedBytes(mask, true) });
  layerExtra.forEach((file) => files.push(file));
  return run('zip', { files });
}

async function decodeProject(project) {
  const names = [project.photo];
  for (const name of project.session.maps || []) names.push('maps/' + name + '.png');
  for (let i = 0; i < (project.session.lights || []).length; i++) names.push('lights/' + i + '.png');
  if (project.session.mask) names.push('mask.png');
  const images = [];
  try {
    for (const name of names) {
      const blob = new Blob([project.files[name]]);
      const bitmap = await createImageBitmap(blob);
      if (!bitmap.width || !bitmap.height) throw new Error('empty image');
      images.push(keepSource(bitmap, blob));
    }
  } catch (error) {
    images.forEach((image) => image.close());
    throw error;
  }
  return images;
}

async function verifiedProject() {
  const bytes = await projectBytes();
  const images = await decodeProject(await run('readProject', { bytes }));
  images.forEach((image) => image.close());
  return bytes;
}

const PROJECT_TYPE = { 'application/x-material-wizard': ['.mwz'] };

const IMAGE_TYPES = { 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/avif': ['.avif'], 'image/bmp': ['.bmp'], 'image/gif': ['.gif'] };

async function saveProject(as) {
  if (!state.original) return;
  const name = readParams().name + '.mwz';
  let handle = state.projectHandle;
  try {
    if (window.showSaveFilePicker && (as || !handle)) {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: text('ui.materialWizard.menu.projectType'), accept: PROJECT_TYPE }] });
    }
    const bytes = await verifiedProject();
    if (!window.showSaveFilePicker) {
      downloadBytes(bytes, name, 'application/x-material-wizard');
      return;
    }
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    state.projectHandle = handle;
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.warn('project save failed', error);
    warningsEl.textContent = text('ui.materialWizard.notes.saveFailed');
  }
}

async function openAny(file, handle) {
  if (/\.mwz$/i.test(file.name)) {
    if (await openProject(file)) state.projectHandle = handle || null;
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    useImage(await loadImage(new Blob([bytes], { type: file.type || 'image/png' })), file, bytes);
  }
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    const project = await run('readProject', { bytes }, { transfer: [bytes.buffer] });
    const images = await decodeProject(project);
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
    state.sessionNote = versionNewer(session.version) ? text('ui.materialWizard.notes.newerFile', { v: session.version }) : '';
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
    syncHistoryButtons();
    if (session.sun) {
      sunAngle.az = session.sun[0];
      sunAngle.el = session.sun[1];
      drawSunDial();
    }
    if (inactiveSnap) setStoredLayer(inactive, inactiveSnap);
    setActiveLayer((session.layers && session.layers.active) || 'detail');
    schedule();
    refreshEditor();
    return true;
  } catch (error) {
    console.warn('session open failed', error);
    warningsEl.textContent = text('ui.materialWizard.notes.badFile', { name: file.name });
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
  export: () => document.getElementById('download').click(),
  install: async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
  },
};

export function init() {
  document.getElementById('open-photo').addEventListener('click', () => openFile.click());
  drop.addEventListener('click', () => { if (!state.original) openFile.click(); });
  openFile.addEventListener('change', async () => {
    const file = openFile.files[0];
    openFile.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    useImage(await loadImage(new Blob([bytes], { type: file.type || 'image/png' })), file, bytes);
  });

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
