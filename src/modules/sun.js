import { schedule } from './render.js';
import { presentSoon } from './view.js';
import { commit, remember } from '../services/history.js';
import { text } from '../services/i18n.js';
import { trackOpen } from '../services/progress.js';
import { run } from '../services/worker.js';
import { slotImages, warningsEl, state } from '../services/state.js';
import { canvasFromRGBA, imageDataOf, loadImage } from '../utils/images.js';
import { num } from '../utils/sizes.js';

export const sunAngle = { az: 25, el: 30 };

export const sunDial = document.getElementById('sun-dial');

const DIAL = 128;

const SUN_EL_MIN = -45;

const HORIZON_R = 0.78;

let dialDragging = false;

export function setSun(az, el) {
  sunAngle.az = ((az % 360) + 360) % 360;
  sunAngle.el = Math.max(SUN_EL_MIN, Math.min(90, el));
  drawSunDial();
  presentSoon();
}

function dialRadius(el, R) {
  const h = R * HORIZON_R;
  if (el >= 0) return h * (1 - el / 90);
  return h + (R - h) * (el / SUN_EL_MIN);
}

// Seen from above: the centre is overhead, the bright ring is the horizon, the camera sits at the bottom.

export function drawSunDial() {
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

const endDial = () => { dialDragging = false; };

export function drawLights() {
  const host = document.getElementById('lights');
  host.innerHTML = '';
  state.lights.forEach((light, index) => {
    const row = document.createElement('div');
    row.className = 'mw-light';
    row.innerHTML = '<span>' + text('ui.materialWizard.maps.light', { n: index + 1 }) + '</span>';
    const az = document.createElement('input');
    az.type = 'number';
    az.value = light.az;
    az.dataset.title = 'ui.materialWizard.maps.azimuth';
    az.setAttribute('aria-label', text('ui.materialWizard.maps.azimuth'));
    az.addEventListener('focus', () => remember());
    az.addEventListener('input', () => { light.az = num(az.value, 0); });
    az.addEventListener('change', () => { light.az = num(az.value, 0); commit(); });
    const el = document.createElement('input');
    el.type = 'number';
    el.value = light.el;
    el.dataset.title = 'ui.materialWizard.maps.elevation';
    el.setAttribute('aria-label', text('ui.materialWizard.maps.elevation'));
    el.addEventListener('focus', () => remember());
    el.addEventListener('input', () => { light.el = num(el.value, 45); });
    el.addEventListener('change', () => { light.el = num(el.value, 45); commit(); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = text('ui.materialWizard.maps.remove');
    remove.addEventListener('click', () => { remember(); state.lights.splice(index, 1); commit(); drawLights(); });
    row.appendChild(az);
    row.appendChild(el);
    row.appendChild(remove);
    host.appendChild(row);
  });
}

export function init() {
  sunDial.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    sunDial.setPointerCapture(event.pointerId);
    dialDragging = true;
    dialSun(event);
  });
  sunDial.addEventListener('pointermove', (event) => { if (dialDragging) dialSun(event); });
  sunDial.addEventListener('pointerup', endDial);
  sunDial.addEventListener('pointercancel', endDial);
  sunDial.addEventListener('dblclick', (event) => { event.stopPropagation(); setSun(25, 30); });
  sunDial.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSun(sunAngle.az, sunAngle.el + (event.deltaY < 0 ? 3 : -3));
  }, { passive: false });
  document.getElementById('add-light').addEventListener('click', () => document.getElementById('light-file').click());
  document.getElementById('light-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      await trackOpen(file, async () => {
        remember();
        const image = await loadImage(file);
        state.lights.push({ image, az: state.lights.length * 90, el: 45 });
        commit();
        drawLights();
      });
    } catch (error) {
      console.warn('open failed', error);
      warningsEl.textContent = text('ui.materialWizard.notes.badFile', { name: file.name });
    }
  });

  document.getElementById('solve-lights').addEventListener('click', async () => {
    if (state.lights.length < 3) {
      warningsEl.textContent = text('ui.materialWizard.notes.lights');
      return;
    }
    remember();
    const w = 256;
    const h = 256;
    const images = state.lights.map((light) => imageDataOf(light.image, w, h).data);
    const lights = state.lights.map((light) => ({ az: light.az, el: light.el }));
    const solved = await run('lights', { images, lights, w, h }, { transfer: images.map((data) => data.buffer) });
    state.original = canvasFromRGBA(solved.albedo, w, h);
    state.photoBytes = null;
    state.photoName = null;
    slotImages.normal = canvasFromRGBA(solved.normal, w, h);
    document.querySelector('[data-slot-mode="normal"]').value = 'load';
    document.querySelector('[data-slot-mode="albedo"]').value = 'load';
    slotImages.albedo = state.original;
    commit();
    schedule();
  });
}
