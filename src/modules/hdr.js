import { presentCurrent, viewSelect } from './view.js';
import { text } from '../services/i18n.js';
import { drop, state } from '../services/state.js';

let hdrCanvas = document.getElementById('view-hdr');

const hdrNote = document.getElementById('hdr-note');

const HDR_PEAK = 1000;

// { kind: 'gpu', device, ctx } for a WebGPU extended canvas, or { kind: 'pq', ctx, key } for a rec2100-pq 2D canvas.

let hdrOut = null;

let hdrProbe = null;

export function hdrScreen() {
  return window.matchMedia('(dynamic-range: high)').matches;
}

async function gpuHdr() {
  if (!navigator.gpu || typeof GPUTextureUsage === 'undefined') return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const c = document.createElement('canvas');
    const ctx = c.getContext('webgpu');
    if (!ctx) { device.destroy(); return null; }
    ctx.configure({
      device,
      format: 'rgba16float',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      toneMapping: { mode: 'extended' },
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    });
    const conf = ctx.getConfiguration && ctx.getConfiguration();
    if (!conf || !conf.toneMapping || conf.toneMapping.mode !== 'extended') {
      ctx.unconfigure();
      device.destroy();
      return null;
    }
    c.id = hdrCanvas.id;
    c.hidden = true;
    c.setAttribute('aria-hidden', 'true');
    hdrCanvas.replaceWith(c);
    hdrCanvas = c;
    device.lost.then(() => {
      if (hdrOut && hdrOut.device === device) { hdrOut = null; hdrProbe = null; hideHdr(); }
    });
    return { kind: 'gpu', device, ctx };
  } catch (e) {
    console.warn('Material Wizard: WebGPU HDR unavailable', e);
    return null;
  }
}

function pqHdr() {
  if (typeof Float16Array === 'undefined') return null;
  const tries = [
    ['colorType', { colorSpace: 'rec2100-pq', colorType: 'float16' }],
    ['pixelFormat', { colorSpace: 'rec2100-pq', pixelFormat: 'float16' }],
  ];
  const off = document.createElement('canvas');
  if (typeof off.configureHighDynamicRange === 'function') {
    try { off.configureHighDynamicRange({ mode: 'extended' }); } catch (e) { /* the context options carry it */ }
  }
  for (const [key, opt] of tries) {
    try {
      const probe = off.getContext('2d', opt);
      const attr = probe && probe.getContextAttributes && probe.getContextAttributes();
      const type = attr && (attr.colorType || attr.pixelFormat);
      if (!attr || attr.colorSpace !== 'rec2100-pq' || type !== 'float16') continue;
      if (typeof hdrCanvas.configureHighDynamicRange === 'function') {
        try { hdrCanvas.configureHighDynamicRange({ mode: 'extended' }); } catch (e) { /* the context options carry it */ }
      }
      const ctx = hdrCanvas.getContext('2d', opt);
      return ctx ? { kind: 'pq', ctx, key } : null;
    } catch (e) { /* next */ }
  }
  return null;
}

// Returns the HDR output once it is known; the first call starts the probe and redraws when it finishes.

export function hdrReady() {
  if (hdrOut || hdrProbe) return hdrOut;
  hdrProbe = (async () => {
    hdrOut = (await gpuHdr()) || pqHdr();
    console.log('Material Wizard: HDR output', hdrOut ? hdrOut.kind : 'none');
    if (hdrOut && state.original && viewSelect.value === 'preview') presentCurrent();
  })();
  return null;
}

let hdrBits = null;

function float16Bits(src) {
  if (!hdrBits || hdrBits.length !== src.length) hdrBits = new Uint16Array(src.length);
  const bits = hdrBits;
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i];
    const x = u[0];
    const sign = (x >>> 16) & 0x8000;
    if ((x & 0x7fffffff) < 0x38800000) { bits[i] = sign; continue; }
    if ((x & 0x7fffffff) > 0x477fe000) { bits[i] = sign | 0x7c00; continue; }
    bits[i] = sign | ((((x >>> 23) & 0xff) - 112) << 10) | ((x >>> 13) & 0x3ff);
  }
  return bits;
}

export function hideHdr() {
  drop.classList.remove('is-hdr');
  hdrCanvas.hidden = true;
  hdrBits = null;
  if (hdrCanvas.width > 1) hdrCanvas.width = hdrCanvas.height = 1;
}

export function syncHdrNote() {
  const show = viewSelect.value === 'preview' && drop.classList.contains('is-hdr');
  hdrNote.hidden = !show;
  if (show) hdrNote.textContent = text('ui.materialWizard.preview.hdr', { nits: HDR_PEAK });
}

export function presentHdr(frame) {
  if (!frame || !hdrOut) { hideHdr(); return; }
  if (hdrCanvas.width !== frame.w || hdrCanvas.height !== frame.h) {
    hdrCanvas.width = frame.w;
    hdrCanvas.height = frame.h;
  }
  const bits = frame.half ? frame.data : float16Bits(frame.data);
  try {
    if (hdrOut.kind === 'gpu') {
      hdrOut.device.queue.writeTexture(
        { texture: hdrOut.ctx.getCurrentTexture() },
        bits,
        { bytesPerRow: frame.w * 8 },
        { width: frame.w, height: frame.h },
      );
    } else {
      const opt = { colorSpace: 'rec2100-pq' };
      opt[hdrOut.key] = 'float16';
      hdrOut.ctx.putImageData(new ImageData(new Float16Array(bits.buffer, bits.byteOffset, bits.length), frame.w, frame.h, opt), 0, 0);
    }
  } catch (e) {
    console.warn('Material Wizard: HDR present failed', e);
    hdrOut = null;
    hideHdr();
    return;
  }
  hdrCanvas.hidden = false;
  drop.classList.add('is-hdr');
}
