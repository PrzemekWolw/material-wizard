import { commit, remember } from '../services/history.js';
import { text } from '../services/i18n.js';
import { ADJUST_FIELDS, FLAT_CURVE, curveValue, parseCurve } from '../utils/lut.js';

export const ADJUST_SLOTS = ['albedo', 'height', 'roughness', 'metallic', 'ao', 'opacity'];

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function adjustParam(slot, key) {
  return 'adj' + cap(slot) + cap(key);
}

// The levels, contrast and curve of one slot, from readParams values.
export function adjustOf(params, slot) {
  const a = {};
  ADJUST_FIELDS.forEach(([key, , , def]) => {
    const v = params[adjustParam(slot, key)];
    a[key] = typeof v === 'number' ? v : def;
  });
  a.curve = parseCurve(params[adjustParam(slot, 'curve')]);
  return a;
}

export function adjustMarkup(slot) {
  const copy = (key) => 'data-copy="ui.materialWizard.adjust.' + key + '">' + text('ui.materialWizard.adjust.' + key);
  return '<details class="mw-more mw-adjust" data-slot-adjust="' + slot + '"><summary ' + copy('title') + '</summary>'
    + ADJUST_FIELDS.map(([key, min, max, def]) => '<label class="mw-field"><span ' + copy(key) + '</span>'
      + '<input type="range" data-param="' + adjustParam(slot, key) + '" min="' + min + '" max="' + max + '" step="0.01" value="' + def + '"></label>').join('')
    + '<div class="mw-curve"><div class="mw-curve-head"><span ' + copy('curve') + '</span>'
    + '<button type="button" class="mw-round mw-curve-reset" data-curve-reset="' + slot + '" hidden data-title="ui.materialWizard.resetSetting"><i class="fa-solid fa-rotate-left"></i></button></div>'
    + '<canvas data-curve="' + slot + '" tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="1" data-title="ui.materialWizard.adjust.curveTip"></canvas>'
    + '<input type="hidden" data-param="' + adjustParam(slot, 'curve') + '" value="' + FLAT_CURVE.join(',') + '"></div>'
    + '</details>';
}

const inputOf = (canvas) => document.querySelector('[data-param="' + adjustParam(canvas.dataset.curve, 'curve') + '"]');

const drawn = new WeakMap();

function paint(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const input = inputOf(canvas);
  const points = parseCurve(input.value);
  const style = getComputedStyle(canvas);
  const accent = style.getPropertyValue('--accent').trim() || '#1ba1e2';
  const line = style.getPropertyValue('--line').trim() || '#888';
  const ink = style.color;
  const key = input.value + accent + line + ink + w + 'x' + h + (canvas.sel || 0) + (document.activeElement === canvas);
  if (drawn.get(canvas) === key) return;
  drawn.set(canvas, key);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo(Math.round(w * i / 4) + 0.5, 0);
    ctx.lineTo(Math.round(w * i / 4) + 0.5, h);
    ctx.moveTo(0, Math.round(h * i / 4) + 0.5);
    ctx.lineTo(w, Math.round(h * i / 4) + 0.5);
  }
  ctx.moveTo(0, h);
  ctx.lineTo(w, 0);
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= w; x++) {
    const y = h - curveValue(points, x / w) * h;
    if (x) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
  points.forEach((v, i) => {
    const x = Math.min(w - 5, Math.max(5, w * i / 4));
    const y = Math.min(h - 5, Math.max(5, h - v * h));
    ctx.fillStyle = accent;
    ctx.fillRect(x - 5, y - 5, 10, 10);
    if (i === (canvas.sel || 0) && document.activeElement === canvas) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 7.5, y - 7.5, 15, 15);
    }
  });
  canvas.setAttribute('aria-valuenow', points[canvas.sel || 0].toFixed(2));
  canvas.setAttribute('aria-valuetext', text('ui.materialWizard.adjust.point', { n: (canvas.sel || 0) + 1, v: points[canvas.sel || 0].toFixed(2) }));
}

export function syncCurves() {
  document.querySelectorAll('[data-curve]').forEach((canvas) => {
    paint(canvas);
    const input = inputOf(canvas);
    document.querySelector('[data-curve-reset="' + canvas.dataset.curve + '"]').hidden = input.value === FLAT_CURVE.join(',');
  });
}

function setPoint(canvas, i, v) {
  const input = inputOf(canvas);
  const points = parseCurve(input.value);
  points[i] = Math.round(Math.min(Math.max(v, 0), 1) * 1000) / 1000;
  input.value = points.join(',');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  syncCurves();
}

function finish(canvas) {
  inputOf(canvas).dispatchEvent(new Event('change', { bubbles: true }));
  commit();
}

export function init() {
  const host = document.getElementById('slots');
  let drag = null;
  const pointAt = (canvas, event) => {
    const r = canvas.getBoundingClientRect();
    return { i: Math.min(4, Math.max(0, Math.round((event.clientX - r.left) / r.width * 4))), v: 1 - (event.clientY - r.top) / r.height };
  };
  host.addEventListener('pointerdown', (event) => {
    const canvas = event.target.closest('[data-curve]');
    if (!canvas || event.button > 0) return;
    remember();
    canvas.setPointerCapture(event.pointerId);
    const at = pointAt(canvas, event);
    canvas.sel = at.i;
    drag = { canvas, id: event.pointerId };
    setPoint(canvas, at.i, at.v);
  });
  host.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    setPoint(drag.canvas, drag.canvas.sel, pointAt(drag.canvas, event).v);
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    finish(drag.canvas);
    drag = null;
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('keydown', (event) => {
    const canvas = event.target.closest('[data-curve]');
    if (!canvas) return;
    const sel = canvas.sel || 0;
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      canvas.sel = Math.min(4, Math.max(0, sel + (event.key === 'ArrowLeft' ? -1 : 1)));
      syncCurves();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      remember();
      setPoint(canvas, sel, parseCurve(inputOf(canvas).value)[sel] + (event.key === 'ArrowUp' ? step : -step));
      finish(canvas);
    } else return;
    event.preventDefault();
  });
  host.addEventListener('focusin', syncCurves);
  host.addEventListener('focusout', () => requestAnimationFrame(syncCurves));
  host.addEventListener('toggle', syncCurves, true);
  host.addEventListener('click', (event) => {
    const button = event.target.closest('[data-curve-reset]');
    if (!button) return;
    remember();
    const input = document.querySelector('[data-param="' + adjustParam(button.dataset.curveReset, 'curve') + '"]');
    input.value = FLAT_CURVE.join(',');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    commit();
    syncCurves();
  });
  host.addEventListener('dblclick', (event) => {
    const canvas = event.target.closest('[data-curve]');
    if (canvas) document.querySelector('[data-curve-reset="' + canvas.dataset.curve + '"]').click();
  });
}
