import { sunColor, sunDirection } from './sky.js';

const PREVIEW_SHAPES = { plane: 0, sphere: 1, cube: 2 };
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function addLit(e) {
  const { gl, canvas, floatOk, rts, finals, mipped } = e;

  function exposureOf(sun, sunRgb) {
    const grey = sunRgb.map((c, i) => 0.18 * (c * Math.max(sun[1], 0) / Math.PI + e.skyUp[i]));
    return 0.7 / Math.max(0.2126 * grey[0] + 0.7152 * grey[1] + 0.0722 * grey[2], 1e-6);
  }

  function targetLuminance(sunRgb) {
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const factor = Math.min(1, lum(sunRgb) / lum(sunColor([0, 1, 0])));
    const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const horizon = 0.00154;
    return factor <= horizon
      ? 0.05 + 0.05 * smooth(0, horizon, factor)
      : 0.1 + 0.6 * smooth(horizon, 1, factor);
  }

  function exposureScale(hdr, sunRgb) {
    const long = Math.max(hdr.w, hdr.h);
    const mw = Math.max(1, Math.round(64 * hdr.w / long));
    const mh = Math.max(1, Math.round(64 * hdr.h / long));
    const meter = e.rt('meter', mw, mh);
    e.draw('meter', meter, { uTex: hdr }, { uCell: [1 / mw, 1 / mh] });
    const buf = e.read(meter);
    const material = [];
    const sky = [];
    for (let i = 0; i < buf.length; i += 4) {
      const log = (buf[i] * 256 + buf[i + 1]) / 65535 * 24 - 12;
      if (buf[i + 2] >= 128) material.push(log);
      else sky.push(log);
    }
    const target = targetLuminance(sunRgb);
    const scaleOf = (logs) => {
      if (!logs.length) return null;
      logs.sort((a, b) => a - b);
      const n = logs.length;
      const lo = Math.floor(n * 0.3);
      const hi = Math.max(lo + 1, Math.ceil(n * 0.9));
      let avg = 0;
      for (let i = lo; i < hi; i++) avg += logs[i];
      avg /= hi - lo;
      const highlightOut = Math.log2(target) + logs[Math.min(n - 1, Math.floor(n * 0.97))] - avg;
      avg += Math.min(0.75 * Math.max(highlightOut - 1, 0), 2);
      const scale = target / 2 ** avg;
      return Number.isFinite(scale) ? Math.min(32, Math.max(1 / 32, scale)) : null;
    };
    const scales = [];
    const materialScale = scaleOf(material);
    const skyScale = sky.length >= buf.length * 0.02 ? scaleOf(sky) : null;
    if (materialScale != null) scales.push(materialScale);
    if (skyScale != null) scales.push(skyScale);
    if (!scales.length) return 1;
    return Math.min.apply(null, scales);
  }

  // Ease in log space. Closing down (a brighter scene) is quicker, and tiny meter noise is ignored.
  function smoothScale(target) {
    const now = performance.now();
    if (e.shownScale == null) {
      e.shownScale = target;
      e.exposureTime = now;
      return target;
    }
    const dt = Math.min(0.05, Math.max(0, (now - e.exposureTime) / 1000));
    e.exposureTime = now;
    const delta = Math.log(target) - Math.log(e.shownScale);
    if (Math.abs(delta) < 0.05) return e.shownScale;
    const speed = delta < 0 ? 12 : 5;
    e.shownScale = Math.exp(Math.log(e.shownScale) + delta * (1 - Math.exp(-Math.max(dt, 0.001) * speed)));
    return e.shownScale;
  }

  // The preview sun is 22 against the game's 100000, so the EV is taken in game units.
  function bloomChain(hdr, exposure, scale) {
    const ev = -Math.log2(exposure * 22 / 100000);
    const aperture = 1.4 + Math.min(Math.max((ev + 5) / 20, 0), 1) * (22 - 1.4);
    let count = Math.min(9, Math.max(1, Math.floor(Math.log2(Math.max(hdr.w, hdr.h)) + 1) - 2));
    while (count > 1 && aperture * 0.5 <= count - 1) count--;
    if (count < 2) return null;
    const levels = [hdr];
    for (let i = 1; i < count; i++) {
      const src = levels[i - 1];
      const dst = e.rt('bloom' + i, Math.max(1, hdr.w >> i), Math.max(1, hdr.h >> i), 'rgba16f');
      e.draw('bloomDown', dst, { uTex: src }, { uTexel: [1 / src.w, 1 / src.h], uFirst: i === 1 ? 1 : 0, uExposure: i === 1 ? scale : 1 });
      levels.push(dst);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = count - 1; i > 1; i--) {
      const src = levels[i];
      e.draw('bloomUp', levels[i - 1], { uTex: src }, {
        uTexel: [1 / src.w, 1 / src.h],
        uWeight: 0.7 * Math.min(Math.max(aperture * 0.5 - i, 0), 1),
      });
    }
    gl.disable(gl.BLEND);
    return { tex: levels[1], weight: 0.7 * Math.min(Math.max(aperture * 0.5 - 1, 0), 1) };
  }

  function layoutSize(repeat) {
    const w = e.width * Math.max(1, repeat[0]);
    const h = e.height * Math.max(1, repeat[1]);
    const scale = Math.min(1, Math.max(4096, e.width, e.height) / Math.max(w, h));
    return [Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale))];
  }

  function screenSize(view, params) {
    const size = params.viewSize;
    if (size && size[0] >= 2 && size[1] >= 2) return size;
    return layoutSize(params.layout || [1, 1]);
  }
  function dropLit() {
    rts.forEach((target, name) => {
      if (name === 'litHdr' || name === 'litPq' || name === 'meter' || name === 'skyView' || name.startsWith('bloom')) e.freeTarget(name);
    });
    e.dropHdr();
  }

  // Draws to the canvas, or to out (a render target) for thumbnails.
  function present(view, params, out = null) {
    frameId++;
    e.accumulating = false;
    if (e.busy && !out) return;
    if (view !== 'preview') {
      e.liveParams = null;
      if (!out) dropLit();
    }
    e.hdrFrameBuf = null;
    if (!finals.albedo) return;
    const size = out ? [out.w, out.h] : screenSize(view, params);
    e.screenW = size[0];
    e.screenH = size[1];
    if (!out && (canvas.width !== e.screenW || canvas.height !== e.screenH)) {
      canvas.width = e.screenW;
      canvas.height = e.screenH;
    }
    if (view === 'preview') {
      drawPreview(params, out, 0);
      return;
    }
    const map = {
      source: [finals.photo, 0],
      albedo: [finals.albedo, 0],
      height: [finals.height, 2],
      normal: [finals.normal, 1],
      detail: [view === 'detail' ? e.viewTarget('detail') : null, 1],
      ao: [finals.ao, 2],
      rough: [finals.rough, 2],
      metal: [finals.metal, 2],
      opacity: [finals.opacity, 2],
      zones: [view === 'zones' ? e.viewTarget('zones') : null, 0],
    };
    const chosen = map[view] || map.albedo;
    const before = view === 'albedo' ? finals.photo : chosen[0];
    e.draw('show', out, { uTex: chosen[0], uBefore: before }, {
      uSplit: params.split == null ? 0 : params.split,
      uMode: chosen[1],
      uRepeatX: (params.layout || [1, 1])[0],
      uRepeatY: (params.layout || [1, 1])[1],
      uSeam: params.seamLines ? 1 : 0,
      uZoom: params.zoom > 0 ? params.zoom : 1,
      uCenter: params.center || [0.5, 0.5],
      uMul: view === 'albedo' ? e.tint : [1, 1, 1],
    });
  }

  // The lit view adds one jittered sample per frame into a float target, up to MAX_SAMPLES, and keeps
  // going while the exposure adapts. A new present() or a held pointer stops it.
  const MAX_SAMPLES = 32;
  let frameId = 0;
  const halton = (i, b) => {
    let f = 1, r = 0;
    for (; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); }
    return r;
  };

  function drawPreview(params, out, n) {
    const repeat = params.layout || [1, 1];
    const zoom = params.zoom > 0 ? params.zoom : 1;
    const center = params.center || [0.5, 0.5];
    const terrain = params.terrain && e.terrain;
    const baseB = terrain ? terrain.baseB || finals.albedo : finals.albedo;
    const baseN = terrain ? terrain.baseN || finals.normal : finals.normal;
    const detN = terrain ? terrain.detN || finals.normal : finals.normal;
    const maps = terrain
      ? [baseB, baseN, terrain.baseD, terrain.macB, terrain.macN, terrain.macD, terrain.detB, terrain.detD, detN]
      : [finals.albedo, finals.normal, finals.rough, finals.metal, finals.ao, finals.opacity];
    maps.forEach((target) => {
      if (!mipped.has(target.tex)) {
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        mipped.add(target.tex);
      }
      e.minFilter.set(target.tex, gl.LINEAR_MIPMAP_LINEAR);
    });
    const savedS = e.wrapS;
    const savedT = e.wrapT;
    e.wrapS = gl.REPEAT;
    e.wrapT = gl.REPEAT;
    const sun = sunDirection(params.light || [25, 30]);
    const sunRgb = sunColor(sun);
    const env = e.bakeSky(sun, sunRgb);
    const hdr = floatOk ? e.rt('litHdr', e.screenW, e.screenH, 'rgba16f') : null;
    if (n > 0) {
      gl.enable(gl.BLEND);
      gl.blendColor(0, 0, 0, 1 / (n + 1));
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    }
    const shared = {
      uDirect: hdr ? 0 : 1,
      uTint: e.tint,
      uSun: sun,
      uSunColor: sunRgb,
      uView: [e.screenW, e.screenH],
      uZoom: zoom,
      uCenter: center,
      uJitter: n > 0 ? [halton(n, 2) - 0.5, halton(n, 3) - 0.5] : [0, 0],
    };
    if (terrain) {
      const tp = params.terrain;
      const v = tp.values;
      e.draw('terrainPreview', hdr || out, {
        uBaseB: maps[0], uBaseN: maps[1], uBaseD: maps[2], uMacB: maps[3], uMacN: maps[4], uMacD: maps[5], uDetB: maps[6], uDetN: detN, uDetD: maps[7], ...env,
      }, {
        ...shared,
        uCam: tp.cam,
        uSizes: v.sizes.map((s) => Math.max(0.01, s)),
        uMacroDist: v.macroDistances,
        uDetailDist: v.detailDistances,
        uAtten: [...v.macroDistAtten, ...v.detailDistAtten],
        uStrB: v.strengths.baseColor,
        uStrN: v.strengths.normal,
        uStrR: v.strengths.roughness,
        uStrAO: v.strengths.ao,
        uStrH: v.strengths.height,
        uFlatBase: tp.flatBase ? 1 : 0,
        uDebug: tp.debug,
        uBlend: tp.blend ? 1 : 0,
      });
    } else {
      e.draw('preview', hdr || out, {
        uAlb: maps[0], uN: maps[1], uR: maps[2], uM: maps[3], uAO: maps[4], uOp: maps[5], ...env, uSky: e.renderSkyView(sun, sunRgb, repeat, zoom, center),
      }, {
        ...shared,
        uFactor: [e.factors.roughness, e.factors.metallic, e.factors.opacity, e.factors.normal],
        uRes: [e.width, e.height],
        uRot: params.rot || IDENTITY3,
        uRepeatX: repeat[0],
        uRepeatY: repeat[1],
        uShape: PREVIEW_SHAPES[params.shape] || 0,
        uAlphaBg: params.alphaView === 'background' ? 1 : 0,
        uSeam: params.seamLines ? 1 : 0,
      });
    }
    gl.disable(gl.BLEND);
    e.wrapS = savedS;
    e.wrapT = savedT;
    maps.forEach((target) => e.minFilter.delete(target.tex));
    if (!hdr) return;
    // Metered on the first sample; a held pointer keeps the shown exposure.
    const live = params.viewSize && !out;
    const hold = live && params.hold && e.shownScale != null;
    if (n === 0 && !hold) e.meterTarget = exposureScale(hdr, sunRgb);
    const target = hold ? e.shownScale : e.meterTarget;
    const scale = live ? (hold ? e.shownScale : smoothScale(target)) : target;
    e.liveParams = live ? params : null;
    const bloom = out ? null : bloomChain(hdr, exposureOf(sun, sunRgb) * scale, scale);
    const lit = { uHdr: hdr, uBloom: bloom ? bloom.tex : hdr };
    const litU = { uBloomScale: bloom ? bloom.weight : 0, uExposure: scale };
    e.draw('litFinal', out, lit, litU);
    e.hdrFrameBuf = params.hdr && !out && !e.hdrReadFailed ? e.readHdr(lit, litU, params.hdr) : null;
    if (out || params.hold) return;
    const adapting = Math.abs(Math.log(target / scale)) > 0.05;
    if (n + 1 >= MAX_SAMPLES && !adapting && !e.hdrPending()) return;
    const id = frameId;
    const screen = [e.screenW, e.screenH];
    e.accumulating = true;
    requestAnimationFrame(() => {
      if (id !== frameId) return;
      e.accumulating = false;
      if (!finals.albedo || gl.isContextLost()) return;
      [e.screenW, e.screenH] = screen;
      drawPreview(params, null, Math.min(n + 1, MAX_SAMPLES - 1));
      if (e.onFrame) e.onFrame();
    });
  }

  // Each view is drawn at twice the thumbnail size into a render target, read back and scaled down.
  const thumbCanvas = document.createElement('canvas');
  function thumbnails(targets) {
    if (!finals.albedo) return;
    Object.keys(targets).forEach((view) => {
      const thumb = targets[view];
      const k = Math.min(1, 2 * Math.max(thumb.width, thumb.height) / Math.max(e.width, e.height));
      const out = e.rt('thumb', Math.max(2, Math.round(e.width * k)), Math.max(2, Math.round(e.height * k)));
      present(view, { split: 0, layout: [1, 1], seamLines: false, shape: 'plane', viewSize: [out.w, out.h] }, out);
      thumbCanvas.width = out.w;
      thumbCanvas.height = out.h;
      thumbCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(e.read(out).buffer), out.w, out.h), 0, 0);
      thumb.getContext('2d').drawImage(thumbCanvas, 0, 0, thumb.width, thumb.height);
    });
    e.freeTarget('thumb');
  }

  Object.assign(e, { exposureOf, targetLuminance, exposureScale, smoothScale, bloomChain, layoutSize, screenSize, dropLit, present, thumbnails });
}
