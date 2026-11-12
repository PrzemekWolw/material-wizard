import { autoFrame, homographyFromQuad, warpBuffer } from '../tile/index.js';
import { createTileEditor, coverScale } from '../tile-editor.js';
import { paintRange, schedule, scheduleTileWork } from './render.js';
import { drawLights } from './sun.js';
import { commit, remember } from '../services/history.js';
import { text } from '../services/i18n.js';
import { cancelled, run } from '../services/worker.js';
import { canvas, drop, readParams, slotImages, state } from '../services/state.js';
import { canvasFromRGBA, extract, idOf, imageDataOf, orient, paint } from '../utils/images.js';
import { shapeRatio, sizeFromRatio } from '../utils/sizes.js';
export let repeatInfo = null;

let repeatSize = null;

const orientCache = { key: '', image: null };

function orientedOriginal(runs) {
  const key = idOf(state.original) + runs;
  if (orientCache.key !== key) {
    orientCache.key = key;
    orientCache.image = orient(state.original, runs);
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

function tileOpts(params) {
  return {
    cut: params.tileBlend === 'cut', soft: params.tileSoft, even: params.tileEven !== false,
    lightColors: params.lightColors, lightRange: params.lightRange, lightStrength: params.lightStrength,
    bomb: params.bombAmount > 0 ? { amount: params.bombAmount, seed: params.bombSeed } : null,
  };
}

const tileCache = { key: '', result: null, pendingKey: '', pending: null };

// Image keys the worker holds, per group ('full' tiling, 'preview' editor tile).
const heldKeys = { full: new Set(), preview: new Set() };

function hold(group, entries) {
  const held = heldKeys[group];
  const stale = [...held].filter((key) => !entries.some((entry) => entry.key === key));
  if (stale.length) run('drop', { keys: stale });
  stale.forEach((key) => held.delete(key));
  entries.forEach(({ key, image, w, h }) => {
    if (held.has(key)) return;
    const data = imageDataOf(image, w, h).data;
    run('hold', { key, data, w, h }, { transfer: [data.buffer] });
    held.add(key);
  });
}

function forgetHeld(error) {
  if (/not held/.test(error.message)) Object.values(heldKeys).forEach((held) => held.clear());
  throw error;
}

// The tiled photo and loaded maps. Returns the result, or a promise while the worker tiles.
export function tiledSet(params, slotNames) {
  const base = orientedOriginal(params.roadRuns);
  const sources = {};
  slotNames.forEach((name) => {
    sources[name] = extractCached(slotImages[name], params.slots[name].channel, params.slots[name].invert);
  });
  if (!params.tileOn) return { source: base, slots: sources, clipped: [], pow2: null, scores: null };
  const W = base.width;
  const H = base.height;
  const frame = currentFrame(params, W, H);
  const sides = tileSides(params);
  const opts = tileOpts(params);
  const size = ':' + W + 'x' + H;
  const entries = [{ key: idOf(base) + size, image: base, w: W, h: H }]
    .concat(slotNames.map((name) => ({ key: idOf(sources[name]) + size, image: sources[name], w: W, h: H })));
  const key = entries.map((entry) => entry.key).concat(JSON.stringify([frame, sides, opts, params.tileX, params.tileY])).join('|');
  if (tileCache.key === key) return tileCache.result;
  if (tileCache.pendingKey === key) return tileCache.pending;
  hold('full', entries);
  const ratio = frameRatio(params.cropShape, W, H);
  const normalIndex = slotNames.indexOf('normal') + 1 || -1;
  const job = run('tile', { keys: entries.map((entry) => entry.key), w: W, h: H, frame, sides, opts, scoreX: !!params.tileX, scoreY: !!params.tileY, normalIndex }, { channel: 'tile' })
    .catch(forgetHeld)
    .then((out) => {
      const result = {
        source: canvasFromRGBA(out.images[0], out.w, out.h),
        slots: {},
        clipped: out.clipped,
        pow2: ratio
          ? sizeFromRatio(2 ** Math.round(Math.log2(Math.max(out.w, out.h))), ratio)
          : { w: 2 ** Math.round(Math.log2(out.w)), h: 2 ** Math.round(Math.log2(out.h)) },
        scores: out.scores,
      };
      slotNames.forEach((name, i) => { result.slots[name] = canvasFromRGBA(out.images[i + 1], out.w, out.h); });
      tileCache.key = key;
      tileCache.result = result;
      return result;
    })
    .finally(() => {
      if (tileCache.pendingKey !== key) return;
      tileCache.pendingKey = '';
      tileCache.pending = null;
    });
  tileCache.pendingKey = key;
  tileCache.pending = job;
  return job;
}

export const cropInput = document.querySelector('[data-param="crop"]');

const PREVIEW_MAX = 1024;

const previewCache = { key: '', base: null, tileKey: '', wantKey: '', tile: null, heatKey: '', heat: null };

function previewOf(full) {
  const key = idOf(full);
  if (previewCache.key !== key) {
    const scale = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height));
    const base = paint(full, Math.max(1, Math.round(full.width * scale)), Math.max(1, Math.round(full.height * scale)));
    previewCache.key = key;
    previewCache.base = base;
    previewCache.tile = null;
    previewCache.tileKey = '';
  }
  return previewCache;
}

function activeTab() {
  const active = document.querySelector('[data-tab].is-active');
  return active ? active.dataset.tab : '';
}

export function tileTabActive() {
  return activeTab() === 'tile';
}

function fixTabActive() {
  return activeTab() === 'fix';
}

let editorQueued = false;

export function refreshEditor() {
  if (editorQueued) return;
  editorQueued = true;
  requestAnimationFrame(() => {
    editorQueued = false;
    paintEditor();
  });
}

function paintEditor() {
  if (!state.original || !(tileTabActive() || fixTabActive())) {
    editor.show(null);
    tileBar.hidden = true;
    return;
  }
  const tileSeg = tileBar.querySelector('.mw-seg');
  if (fixTabActive() && fixMode === 'crop') {
    const preview = previewOf(state.original);
    const frame = cropFrame();
    tileBar.hidden = false;
    tileSeg.hidden = true;
    editor.show({
      base: preview.base,
      frame,
      sides: NO_SIDES,
      ratio: frameRatio(adjustShape.value, state.original.width, state.original.height),
      view: 'frame',
      labels: { size: text('ui.materialWizard.tile.frameSize', { w: Math.round(frame.w * state.original.width), h: Math.round(frame.h * state.original.height) }) },
    });
    return;
  }
  if (fixTabActive()) {
    const preview = previewOf(state.original);
    tileBar.hidden = false;
    tileSeg.hidden = true;
    editor.show({
      base: preview.base,
      view: 'frame',
      fix: {
        mode: fixMode,
        angle: fixAngle(),
        quad: readQuad(),
        full: state.original,
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
  if (params.tileOn && !framing) {
    const key = previewCache.key + JSON.stringify([frame, sides, opts]);
    if (previewCache.tileKey !== key && previewCache.wantKey !== key) tilePreview(preview, key, frame, sides, opts);
    tile = previewCache.tile;
  }
  const heat = tileView === 'repeat' && tile ? repetitionTile(tile) : null;
  tileBar.hidden = false;
  tileBar.querySelectorAll('[data-tile-view]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.tileView === tileView);
    el.setAttribute('aria-pressed', String(el.dataset.tileView === tileView));
  });
  editor.show({
    base: preview.base,
    frame,
    sides,
    ratio: frameRatio(params.cropShape, full.width, full.height),
    tile: heat || tile,
    view: tileView === 'repeat' ? 'tiled' : tileView,
    cover: coverOn,
    seamLines: params.seamLines,
    off: !params.tileOn,
    labels: {
      off: text('ui.materialWizard.tile.offNote'),
      beyond: { left: text('ui.materialWizard.tile.beyondLeft'), right: text('ui.materialWizard.tile.beyondRight'), up: text('ui.materialWizard.tile.beyondUp'), down: text('ui.materialWizard.tile.beyondDown') },
      size: text('ui.materialWizard.tile.frameSize', { w: Math.round(frame.w * full.width), h: Math.round(frame.h * full.height) }),
    },
  });
}

// Tiles the editor preview in the worker. The previous tile stays on screen until it is done.
function tilePreview(preview, key, frame, sides, opts) {
  const base = preview.base;
  const held = 'p' + preview.key;
  previewCache.wantKey = key;
  hold('preview', [{ key: held, image: base, w: base.width, h: base.height }]);
  run('tile', { keys: [held], w: base.width, h: base.height, frame, sides, opts }, { channel: 'previewTile' })
    .catch(forgetHeld)
    .then((out) => {
      if (previewCache.key !== preview.key) return;
      previewCache.tileKey = key;
      previewCache.tile = canvasFromRGBA(out.images[0], out.w, out.h);
      refreshEditor();
    }, (error) => { if (!cancelled(error)) console.warn('tile preview failed', error); })
    .finally(() => { if (previewCache.wantKey === key) previewCache.wantKey = ''; });
}

// The editor tile with the repetition heat over it in the accent colour, once the worker has it.
function repetitionTile(tile) {
  const key = previewCache.tileKey;
  if (previewCache.heatKey === key) return previewCache.heat;
  previewCache.heatKey = key;
  previewCache.heat = null;
  const data = imageDataOf(tile);
  run('repeatMap', { data: data.data, w: data.width, h: data.height }, { transfer: [data.data.buffer], channel: 'repeatMap' }).then((map) => {
    if (previewCache.heatKey !== key) return;
    const heat = canvasFromRGBA(new Uint8Array(map.w * map.h * 4).map((v, i) => (i % 4 === 3 ? map.heat[i >> 2] : 255)), map.w, map.h);
    const out = paint(tile, tile.width, tile.height);
    const ctx = out.getContext('2d');
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.globalCompositeOperation = 'source-over';
    const accent = paint(heat, out.width, out.height);
    const actx = accent.getContext('2d');
    actx.globalCompositeOperation = 'source-in';
    actx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e51400';
    actx.fillRect(0, 0, out.width, out.height);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(accent, 0, 0);
    previewCache.heat = out;
    refreshEditor();
  }, (error) => { if (!cancelled(error)) console.warn('repetition map failed', error); });
  return null;
}

const tileBar = document.getElementById('tile-bar');

let tileView = 'frame';

let framing = false;

export function currentTileView() {
  return tileView;
}

export function setTileView(view) {
  if (![...document.querySelectorAll('[data-tile-view]')].some((el) => el.dataset.tileView === view)) return;
  tileView = view;
  refreshEditor();
}

const coverOn = { left: true, right: true, up: true, down: true };

function syncCoverEyes() {
  document.querySelectorAll('[data-cover]').forEach((input) => {
    input.checked = coverOn[input.dataset.cover] !== false;
    input.nextElementSibling.className = input.checked ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
  });
}

// One word badge per axis: accent fill when the seam is good, neutral otherwise.
export function seamBadges(scores) {
  const host = document.getElementById('seam-note');
  host.replaceChildren();
  if (!scores) return;
  ['x', 'y'].forEach((axis) => {
    const value = scores[axis];
    const rate = value == null ? 'seamOff' : value < 0.04 ? 'seamGood' : value < 0.08 ? 'seamFaint' : 'seamBad';
    const badge = document.createElement('span');
    badge.className = 'mw-badge' + (rate === 'seamGood' ? ' is-good' : '');
    badge.dataset.seam = axis;
    badge.dataset.rate = rate;
    badge.textContent = (axis === 'x' ? text('ui.materialWizard.notes.seamX') : text('ui.materialWizard.notes.seamY')) + ' '
      + (value == null ? text('ui.materialWizard.notes.seamOff') : text('ui.materialWizard.notes.seamRate', { rate: text('ui.materialWizard.notes.' + rate), value: value.toFixed(3) }));
    host.appendChild(badge);
  });
}

function frameString(frame) {
  return [frame.x, frame.y, frame.w, frame.h].map((v) => v.toFixed(5)).join(',');
}

const quadInput = document.getElementById('quad');

const angleInput = document.getElementById('fix-angle');

const IDENTITY_QUAD = [0, 0, 1, 0, 1, 1, 0, 1];

let fixMode = 'rotate';

const adjustShape = document.getElementById('adjust-shape');

const NO_SIDES = { left: { on: false, a: 0, b: 0 }, right: { on: false, a: 0, b: 0 }, up: { on: false, a: 0, b: 0 }, down: { on: false, a: 0, b: 0 } };

function cropFrame() {
  if (!state.original) return { x: 0, y: 0, w: 1, h: 1 };
  return parseFrame(state.adjustFrame) || autoFrame(state.original.width, state.original.height, frameRatio(adjustShape.value, state.original.width, state.original.height), NO_SIDES);
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

let editor = null;

function createEditor() {
  return createTileEditor(drop, {
    onStart() {
      remember();
      if (fixTabActive()) {
        if (fixMode === 'crop' && state.original && !parseFrame(state.adjustFrame)) state.adjustFrame = frameString(cropFrame());
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
        state.adjustFrame = frameString(frame);
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
}

export function showRepeat() {
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

export function init() {
  editor = createEditor();
  tileBar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tile-view]');
    if (button) setTileView(button.dataset.tileView);
  });
  document.querySelector('.mw-fades').addEventListener('change', (event) => {
    const input = event.target.closest('[data-cover]');
    if (!input) return;
    coverOn[input.dataset.cover] = input.checked;
    syncCoverEyes();
    refreshEditor();
  });

  document.getElementById('fix-mode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-fix-mode]');
    if (!button) return;
    fixMode = button.dataset.fixMode;
    document.querySelectorAll('[data-fix-mode]').forEach((el) => {
      el.classList.toggle('is-active', el === button);
      el.setAttribute('aria-pressed', String(el === button));
    });
    document.querySelectorAll('[data-fix]').forEach((el) => { el.hidden = el.dataset.fix !== fixMode; });
    refreshEditor();
  });
  angleInput.addEventListener('input', () => {
    setAngle(angleInput.value);
    refreshEditor();
  });

  document.querySelector('[data-param="cropShape"]').addEventListener('input', () => { cropInput.value = ''; });
  document.getElementById('fit-frame').addEventListener('click', () => {
    remember();
    cropInput.value = '';
    commit();
    scheduleTileWork();
    refreshEditor();
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
  document.getElementById('straighten').addEventListener('click', async () => {
    if (!state.original) return;
    const data = imageDataOf(previewOf(state.original).base);
    const angle = await run('angle', { data: data.data, w: data.width, h: data.height }, { transfer: [data.data.buffer] });
    const turn = 90 - angle;
    setAngle(Math.round(((((turn + 45) % 90) + 90) % 90 - 45) * 10) / 10);
    refreshEditor();
  });

  document.getElementById('fix-angle-reset').addEventListener('click', () => {
    setAngle(0);
    refreshEditor();
  });

  adjustShape.addEventListener('input', () => { state.adjustFrame = ''; refreshEditor(); });
  document.getElementById('adjust-fit').addEventListener('click', () => { state.adjustFrame = ''; refreshEditor(); });
  document.getElementById('apply-crop').addEventListener('click', () => {
    if (!state.original) return;
    const frame = cropFrame();
    if (frame.x < 0.001 && frame.y < 0.001 && frame.w > 0.999 && frame.h > 0.999) return;
    remember();
    state.original = cropCanvas(state.original, frame);
    state.photoBytes = null;
    state.photoName = null;
    slotImages.albedo = state.original;
    Object.keys(slotImages).forEach((name) => {
      if (name !== 'albedo' && slotImages[name]) slotImages[name] = cropCanvas(slotImages[name], frame);
    });
    state.lights.forEach((light) => { light.image = cropCanvas(light.image, frame); });
    const maskInput = document.getElementById('mask-file');
    if (maskInput._image) maskInput._image = cropCanvas(maskInput._image, frame);
    state.adjustFrame = '';
    commit();
    schedule();
    drawLights();
    refreshEditor();
  });

  document.getElementById('apply-rotate').addEventListener('click', () => {
    if (!state.original || !fixAngle()) return;
    remember();
    state.original = rotateFill(state.original, fixAngle());
    state.photoBytes = null;
    state.photoName = null;
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

  document.getElementById('find-repeat').addEventListener('click', async () => {
    if (!state.original) return;
    const data = imageDataOf(orient(state.original, readParams().roadRuns));
    repeatSize = { w: data.width, h: data.height };
    repeatInfo = await run('repeat', { data: data.data, w: data.width, h: data.height }, { transfer: [data.data.buffer] });
    showRepeat();
  });

  document.getElementById('rectify').addEventListener('click', async () => {
    if (!state.original) return;
    const quad = readQuad();
    if (quad.every((v, i) => v === IDENTITY_QUAD[i])) return;
    remember();
    const data = imageDataOf(state.original);
    const warped = await run('warp', { data: data.data, w: data.width, h: data.height, quad }, { transfer: [data.data.buffer] });
    state.original = canvasFromRGBA(warped, data.width, data.height);
    state.photoBytes = null;
    state.photoName = null;
    quadInput.value = IDENTITY_QUAD.join(',');
    commit();
    schedule();
    refreshEditor();
  });
}
