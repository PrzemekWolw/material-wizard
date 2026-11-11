import { hdrReady, hdrScreen, hideHdr, presentHdr, syncHdrNote } from './hdr.js';
import { applyPick, drawLoupe, picker } from './pick.js';
import { engine, paintRange } from './render.js';
import { drawSunDial, setSun, sunAngle, sunDial } from './sun.js';
import { isTerrain, resetTerrainYaw, terrainView, turnTerrain } from './terrain.js';
import { text } from '../services/i18n.js';
import { SLOTS, VIEW_OF_SLOT, canvas, drop, state } from '../services/state.js';
import { num } from '../utils/sizes.js';

const STRIP = ['albedo', 'height', 'normal', 'rough', 'metal', 'ao', 'opacity', 'preview'];

export const THUMB = 96;

export const stripThumbs = {};

export const slotThumbs = {};

export function thumbCanvas() {
  const c = document.createElement('canvas');
  c.width = THUMB;
  c.height = THUMB;
  return c;
}

export const viewSelect = document.getElementById('view-mode');

const stripHost = document.getElementById('map-strip');

export function showView(view) {
  viewSelect.value = view;
  zoomInput.min = String(zoomMin());
  zoomInput.dataset.title = view === 'preview' ? 'ui.materialWizard.preview.zoomTip' : 'ui.materialWizard.zoomTip';
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

export function syncViewButtons() {
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.view === viewSelect.value);
    el.setAttribute('aria-pressed', String(el.dataset.view === viewSelect.value));
  });
}

export const viewZoom = { zoom: 1, x: 0.5, y: 0.5 };

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
  presentSoon();
}

function previewViewSize() {
  if (getComputedStyle(canvas).position !== 'absolute') return null;
  const rect = drop.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return [Math.max(2, Math.round(rect.width * dpr)), Math.max(2, Math.round(rect.height * dpr))];
}

const viewControl = (param) => document.querySelector('[data-param="' + param + '"]');

let pointerHeld = false;

let presentQueued = false;

export function presentCurrent() {
  presentQueued = false;
  const preview = viewSelect.value === 'preview';
  const out = preview && hdrScreen() && !engine.hdrFailed() ? hdrReady() : null;
  const hdr = out ? (out.kind === 'gpu' ? 'srgb' : 'pq') : null;
  engine.present(viewSelect.value, {
    split: num(viewControl('split').value, 0),
    layout: String(viewControl('layout').value).split('x').map((n) => num(n, 1)),
    seamLines: viewControl('seamLines').checked,
    shape: viewControl('shape').value,
    alphaView: viewControl('alphaView').value,
    terrain: preview ? terrainView() : null,
    light: [sunAngle.az, sunAngle.el],
    rot: previewRot,
    zoom: viewZoom.zoom,
    center: [viewZoom.x, viewZoom.y],
    viewSize: preview ? previewViewSize() : null,
    hold: pointerHeld,
    hdr,
  });
  if (!hdr) hideHdr();
  syncHdrFrame();
  syncHdrNote();
}

function syncHdrFrame() {
  const frame = engine.hdrFrame();
  if (frame) presentHdr(frame);
}

// Pointer moves present at most once per frame.
export function presentSoon() {
  if (presentQueued) return;
  presentQueued = true;
  requestAnimationFrame(() => { if (presentQueued) presentCurrent(); });
}

export function drawThumbnails() {
  engine.thumbnails(stripThumbs);
  SLOTS.forEach(([name]) => {
    const c = slotThumbs[name];
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(stripThumbs[VIEW_OF_SLOT[name]], 0, 0);
  });
}

let panFrom = null;

const touches = new Map();

let pinch = null;

function pinchState() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function imagePoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
  const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

export function viewUv(event) {
  const point = imagePoint(event);
  return { x: point.x, y: 1 - point.y };
}

function fittedSize() {
  const rect = canvas.getBoundingClientRect();
  const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  return { w: canvas.width * fit, h: canvas.height * fit };
}

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

export function init() {
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

  new ResizeObserver(() => {
    if (viewSelect.value === 'preview' && state.original) presentCurrent();
  }).observe(drop);
  window.matchMedia('(dynamic-range: high)').addEventListener('change', () => {
    if (state.original) presentCurrent();
    else syncHdrNote();
  });

  viewSelect.addEventListener('change', () => showView(viewSelect.value));
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
  engine.onFrame(syncHdrFrame);
  window.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  const release = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    if (viewSelect.value === 'preview' && state.original) presentSoon();
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  canvas.addEventListener('pointermove', (event) => {
    if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && touches.size >= 2) {
      if (!state.original) return;
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
      presentSoon();
      return;
    }
    if (!event.buttons || !panFrom) return;
    const preview = viewSelect.value === 'preview';
    const lightDrag = event.buttons === 2 || event.shiftKey;
    const dx = event.clientX - panFrom.x;
    const dy = event.clientY - panFrom.y;
    if (preview && event.buttons === 1 && !event.shiftKey && !event.ctrlKey) {
      if (isTerrain()) turnTerrain(dx * 0.01);
      else turnPreview(dx * 0.01, dy * 0.01);
      panFrom = { x: event.clientX, y: event.clientY };
      presentSoon();
      return;
    }
    const movePreview = preview && (event.buttons === 4 || (event.buttons === 1 && event.ctrlKey));
    if (movePreview || (!preview && viewZoom.zoom > 1 && event.buttons === 1)) {
      const fit = fittedSize();
      viewZoom.x -= dx / fit.w / viewZoom.zoom;
      viewZoom.y += dy / fit.h / viewZoom.zoom;
      panFrom = { x: event.clientX, y: event.clientY };
      clampZoom();
      presentSoon();
      return;
    }
    if (!preview || !lightDrag) return;
    setSun(sunAngle.az + dx * 0.5, sunAngle.el - dy * 0.3);
    panFrom = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('dblclick', () => {
    if (!state.original) return;
    if (viewSelect.value === 'preview') {
      previewRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      resetTerrainYaw();
      viewZoom.x = 0.5;
      viewZoom.y = 0.5;
    }
    if (viewZoom.zoom > 1) setZoom(1);
    else presentCurrent();
  });
  canvas.addEventListener('contextmenu', (event) => { if (viewSelect.value === 'preview') event.preventDefault(); });
  drop.addEventListener('wheel', (event) => {
    const tileEdit = drop.querySelector('.mw-tile-edit');
    if (!state.original || (tileEdit && !tileEdit.hidden)) return;
    event.preventDefault();
    setZoom(viewZoom.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), viewUv(event));
  }, { passive: false });
  zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
}
