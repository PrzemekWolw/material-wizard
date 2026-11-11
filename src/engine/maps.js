import { srgbToLinear } from '../utils/color.js';
import { lutOf } from '../utils/lut.js';

export function addMaps(e) {
  const { gl, rts, loaded, warnings, finals, mipped } = e;

  // Uploads are kept while the caller passes the same key; versions tell the stages what changed.
  const uploadKeys = {};
  const versions = {};
  function upload(slot, image, key, old) {
    if (!image && !old) return null;
    if (old) gl.deleteTexture(old);
    uploadKeys[slot] = image ? key : null;
    versions['in:' + slot] = (versions['in:' + slot] || 0) + 1;
    return image ? e.uploadImage(image) : null;
  }

  function setSource(image, key) {
    e.sourceTex = upload('source', image, key, e.sourceTex);
  }

  function setLoaded(name, image, key) {
    loaded[name] = upload(name, image, key, loaded[name]);
  }

  function setMask(image, key) {
    e.maskTex = upload('mask', image, key, e.maskTex);
  }

  function uploadKey(slot) {
    return uploadKeys[slot] || null;
  }

  // A stage reruns when a param it read last time, an input it lists or the image size changed.
  // Params are read through a proxy, so each stage records exactly what it used.
  const stages = {};
  const stageRuns = {};
  function stage(name, params, deps, fn) {
    const prev = stages[name];
    const depKey = [e.width, e.height, e.wrapS, e.wrapT].concat(deps.map((d) => d + ':' + (stages[d] ? stages[d].version : versions[d] || 0))).join();
    if (prev && prev.depKey === depKey && [...prev.reads].every(([key, value]) => JSON.stringify(params[key]) === value)) return prev.out;
    const reads = new Map();
    const tracked = new Proxy(params, {
      get(target, key) {
        if (typeof key === 'string' && !reads.has(key)) reads.set(key, JSON.stringify(target[key]));
        return target[key];
      },
    });
    const out = fn(tracked);
    stages[name] = { depKey, reads, out, version: (prev ? prev.version : 0) + 1 };
    stageRuns[name] = (stageRuns[name] || 0) + 1;
    return out;
  }

  function forgetStages() {
    Object.keys(stages).forEach((name) => delete stages[name]);
    Object.keys(uploadKeys).forEach((slot) => delete uploadKeys[slot]);
  }

  // Levels, contrast and curve of one map, or the map itself when they change nothing.
  function remap(name, src, adjust, color) {
    const table = lutOf(adjust);
    if (!table) return src;
    const lut = e.rt('lut', 256, 1, 'r8');
    gl.bindTexture(gl.TEXTURE_2D, lut.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, table);
    const out = e.rt(name + 'Adj', src.w, src.h, src.format);
    e.draw('remap', out, { uTex: src, uLut: lut }, { uColor: color ? 1 : 0 });
    return out;
  }

  function albedoStage(params) {
    const photo = e.rt('lin', e.width, e.height);
    e.draw('linear', photo, { uTex: e.sourceTex }, {});
    let albSource = photo;
    const periodic = [params.tileOn && params.tileX ? 1 : 0, params.tileOn && params.tileY ? 1 : 0];
    if (params.albedoFix && (params.evenOut > 0 || params.brightX || params.brightY)) {
      const evened = e.rt('even', e.width, e.height);
      e.draw('even', evened, { uTex: photo }, {
        ...e.fitField(photo, periodic, true),
        uEven: params.evenOut,
        uShift: [params.brightX, params.brightXPos, params.brightY, params.brightYPos],
      });
      albSource = evened;
    }
    const albedo = e.rt('albedo', e.width, e.height);
    let shadeScale = 1;
    const white = params.whiteBalance || [1, 1, 1];
    const balanceOn = Math.max(Math.abs(white[0] - 1), Math.abs(white[1] - 1), Math.abs(white[2] - 1)) > 0.001;
    const shadowOn = params.shadowFix > 0.001;
    const picks = params.lightColors || [];
    const colorOn = picks.length > 0 && (params.lightStrength || 0) > 0.001;
    if (!params.albedoFix && !shadowOn && !balanceOn && !colorOn) {
      e.draw('copy', albedo, { uTex: albSource }, { uFlip: 0 });
    } else {
      const coarse = params.albedoFix || shadowOn || colorOn ? e.blurCoarse(albSource) : albSource;
      const field = colorOn ? e.lightField(albSource, coarse, picks, params.lightRange) : { fine: coarse, wide: coarse };
      const delighted = e.rt('delighted', e.width, e.height);
      e.draw('delight', delighted, { uSrc: albSource, uBlur: coarse, uField: field.fine, uFieldWide: field.wide }, {
        uMasked: colorOn ? 1 : 0,
        uLit: shadowOn ? e.litColor(coarse) : [1, 1, 1],
        uStrength: colorOn ? params.lightStrength : (params.albedoFix ? params.delight : 0),
        uHighlight: params.albedoFix ? params.highlight : 0,
        uShadow: params.shadowFix || 0,
        uWhite: white,
      });
      if (params.albedoFix) {
        const mean = e.meanOf(delighted);
        const luma = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
        shadeScale = params.targetMean / Math.max(0.02, luma);
        e.draw('norm', albedo, { uTex: delighted }, { uScale: shadeScale });
      } else e.draw('copy', albedo, { uTex: delighted }, { uFlip: 0 });
    }
    return { photo, albSource, albedo, shadeScale, periodic, pyramid: e.blurPyramid(albedo, 'a') };
  }

  // Height, normal and relief. Relief shades the albedo from the normal and then rebuilds both.
  function shapeStage(params, alb) {
    const heightFormat = 'r16f';
    const generated = e.rt('height', e.width, e.height, heightFormat);
    const drawHeight = (albedo) => {
      e.draw('height', generated, { uAlb: albedo, uSrc: alb.albSource, uB0: alb.pyramid[0], uB1: alb.pyramid[1], uB2: alb.pyramid[2], uB3: alb.pyramid[3] }, {
        uReliefMix: params.heightRelief,
        uContrast: params.heightContrast,
        uBias: params.heightBias,
        uShadeScale: alb.shadeScale,
        uW: params.heightWeights,
      });
      if (params.heightLevel <= 0) return;
      const leveled = e.rt('levelTmp', e.width, e.height, heightFormat);
      e.draw('level', leveled, { uH: generated }, { ...e.fitField(generated, alb.periodic, false), uAmount: params.heightLevel });
      e.draw('copy', generated, { uTex: leveled }, { uFlip: 0 });
    };
    drawHeight(alb.albedo);
    const slot = params.slots;
    let heightMap = generated;
    if (slot.height.mode === 'load' && loaded.height) {
      heightMap = e.rt('heightL', e.width, e.height, heightFormat);
      e.draw('copy', heightMap, { uTex: loaded.height }, { uFlip: 0 });
    } else if (slot.height.mode === 'flat') {
      heightMap = e.rt('heightF', e.width, e.height, heightFormat);
      e.draw('fill', heightMap, {}, { uColor: [slot.height.flat, slot.height.flat, slot.height.flat, 1] });
    }
    heightMap = remap('height', heightMap, params['adjust:height'], false);
    const reliefOn = params.relief > 0 && slot.height.mode !== 'load';
    let hPyramid = e.blurPyramid(heightMap, 'h', heightFormat);
    const texel = [1 / e.width, 1 / e.height];
    const normalUniforms = { uTexel: texel, uBand: params.normalWeights, uStrength: params.normalStrength, uFlip: params.flipY ? 1 : 0 };
    const normal = e.rt('normal', e.width, e.height);
    e.draw('normal', normal, { uH: heightMap, uB0: hPyramid[0], uB1: hPyramid[1], uB2: hPyramid[2] }, normalUniforms);
    let albedo = alb.albedo;
    if (reliefOn) {
      const fitted = e.fitLight(albedo, normal);
      albedo = e.rt('reliefOut', e.width, e.height);
      e.draw('relief', albedo, { uAlb: alb.albedo, uN: normal }, {
        uLight: fitted.light, uStrength: params.relief, uMean: fitted.mean, uFadeHi: params.albedoFix ? 1 : 0,
      });
      drawHeight(albedo);
      hPyramid = e.blurPyramid(heightMap, 'h', heightFormat);
      e.draw('normal', normal, { uH: heightMap, uB0: hPyramid[0], uB1: hPyramid[1], uB2: hPyramid[2] }, normalUniforms);
    }
    const cut = params.detailCutoff;
    const detailUniforms = { ...normalUniforms, uBand: [0, (1 - cut) * 0.25, 0.65, 1] };
    const drawDetail = (target) => e.draw('normal', target, { uH: heightMap, uB0: hPyramid[0], uB1: hPyramid[1], uB2: hPyramid[2] }, detailUniforms);
    const warn = [];
    if (slot.normal.mode === 'load' && loaded.normal) {
      const base = e.rt('nload', e.width, e.height);
      e.draw('copy', base, { uTex: loaded.normal }, { uFlip: params.flipY ? 1 : 0 });
      if (e.meanOf(base)[2] < 0.62) warn.push('objectSpace');
      if (params.addDetail) {
        const detail = e.rt('tmpDetail', e.width, e.height);
        drawDetail(detail);
        const flat = e.rt('tmpA', e.width, e.height);
        const nsoft = e.rt('tmpB', e.width, e.height);
        e.draw('blur', nsoft, { uTex: base }, { uStep: [3 / e.width, 3 / e.height] });
        e.draw('flatMask', flat, { uBase: base, uBlur: nsoft }, { uAmount: params.detailFlatOnly });
        let gain = params.detailStrength;
        if (params.detailAuto) {
          const dMean = e.meanOf(detail);
          const mag = Math.hypot(dMean[0] - 0.5, dMean[1] - 0.5);
          gain *= mag < 0.02 ? 1 : Math.max(0.25, Math.min(2.5, 0.08 / mag));
        }
        const mask = params.atlas && e.maskTex ? { tex: e.maskTex } : flat;
        e.draw('rnm', normal, { uBase: base, uDetail: detail, uMask: mask }, {
          uGain: gain,
          uUseMask: params.detailFlatOnly > 0 || (params.atlas && e.maskTex) ? 1 : 0,
        });
      } else {
        e.draw('copy', normal, { uTex: base }, { uFlip: 0 });
      }
    } else if (slot.normal.mode === 'flat') {
      e.draw('fill', normal, {}, { uColor: [0.5, 0.5, 1, 1] });
    }
    if (params.normalSmooth > 0.001 && slot.normal.mode !== 'flat') {
      const a = e.rt('tmpA', e.width, e.height);
      const b = e.rt('tmpB', e.width, e.height);
      const r1 = params.normalSmooth * 1.5;
      const r2 = params.normalSmooth * 3;
      e.draw('nsmooth', a, { uTex: normal }, { uStep: [r1 / e.width, 0] });
      e.draw('nsmooth', b, { uTex: a }, { uStep: [0, r1 / e.height] });
      e.draw('nsmooth', a, { uTex: b }, { uStep: [r2 / e.width, 0] });
      e.draw('nsmooth', normal, { uTex: a }, { uStep: [0, r2 / e.height] });
    }
    return { heightMap, hPyramid, normal, albedo, drawDetail, warn };
  }

  function update(params) {
    warnings.length = 0;
    if (!e.sourceTex || !e.width) return warnings;
    e.factors = params.factors;
    e.wrapS = params.tileX ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    e.wrapT = params.tileY ? gl.REPEAT : gl.CLAMP_TO_EDGE;

    const alb = stage('albedo', params, ['in:source'], (p) => albedoStage(p));
    const shape = stage('shape', params, ['albedo', 'in:height', 'in:normal', 'in:mask'], (p) => shapeStage(p, alb));
    const { heightMap, hPyramid, normal } = shape;
    const albedo = shape.albedo;
    warnings.push(...shape.warn);

    const addDetail = (p, target, generate, enabled, amount, size) => {
      if (!enabled || amount <= 0) return;
      const gen = e.rt('detailGen', e.width, e.height, 'r16f');
      generate(gen);
      const pyramid = e.blurPyramid(gen, 'd', 'r16f');
      const merged = e.rt('tmpA', e.width, e.height);
      e.draw('addHP', merged, { uBase: target, uGen: gen, uB0: pyramid[0], uB1: pyramid[1], uB2: pyramid[2] }, {
        uGain: amount,
        uSize: size,
      });
      e.draw('copy', target, { uTex: merged }, { uFlip: 0 });
    };

    // A loaded map, optionally with generated detail added, a flat value, or the generated map.
    const slotMap = (p, name, target, make, detailOn, amount, size) => {
      const slot = p.slots[name];
      if (slot.mode === 'load' && loaded[name]) {
        e.draw('copy', target, { uTex: loaded[name] }, { uFlip: 0 });
        addDetail(p, target, make, detailOn, amount, size);
      } else if (slot.mode === 'flat') e.draw('fill', target, {}, { uColor: [slot.flat, slot.flat, slot.flat, 1] });
      else make(target);
      return target;
    };

    const ao = stage('ao', params, ['shape', 'in:ao'], (p) => {
      const makeAo = (target) => e.draw('ao', target, { uH: heightMap }, { uDepth: p.aoDepth, uContrast: p.aoContrast });
      return slotMap(p, 'ao', e.rt('ao', e.width, e.height, 'r8'), makeAo, p.addAoDetail, p.aoDetailAmount, p.aoDetailSize);
    });

    const zones = stage('zones', params, ['albedo'], (p) => {
      const src = e.rt('zoneBlur', e.width, e.height);
      const tmp = e.rt('tmpB', e.width, e.height);
      e.draw('blur', tmp, { uTex: alb.photo }, { uStep: [1.5 / e.width, 0] });
      e.draw('blur', src, { uTex: tmp }, { uStep: [0, 1.5 / e.height] });
      const zoneColor = new Float32Array(24);
      const zoneMat = new Float32Array(24);
      p.zones.slice(0, 6).forEach((zone, i) => {
        zoneColor.set([zone.color[0], zone.color[1], zone.color[2], zone.range], i * 4);
        zoneMat.set([zone.rough, zone.metal, zone.opacity, 1], i * 4);
      });
      const uniforms = { uZoneColor: zoneColor, uZoneMat: zoneMat, uBase: p.zoneBase, uCount: Math.min(6, p.zones.length) };
      const map = e.rt('zones', e.width, e.height);
      e.draw('zones', map, { uTex: src }, { ...uniforms, uShow: 0 });
      return { map, src, uniforms };
    });

    const rough = stage('rough', params, ['shape', 'ao', 'zones', 'in:roughness'], (p) => {
      const makeRough = (target) => {
        const nBlur = e.rt('tmpB', e.width, e.height);
        e.draw('blur', nBlur, { uTex: normal }, { uStep: [2 / e.width, 2 / e.height] });
        e.draw('rough', target, {
          uZones: zones.map, uAO: ao, uH: heightMap, uHb: hPyramid[1], uHf: hPyramid[0], uAlb: albedo, uAb: alb.pyramid[1], uNb: nBlur,
        }, {
          uLocal: p.localRough,
          uCavity: p.cavityRough,
          uWear: p.wearRough,
          uMicro: p.microRough,
          uSpec: p.specRough,
          uNVar: p.nvarRough,
          uMin: p.roughMin,
          uMax: p.roughMax,
          uContrast: p.roughContrast,
        });
      };
      return slotMap(p, 'roughness', e.rt('rough', e.width, e.height, 'r8'), makeRough, p.addRoughDetail, p.roughDetailAmount, p.roughDetailSize);
    });

    const metal = stage('metal', params, ['shape', 'zones', 'in:metallic'], (p) => {
      const makeMetal = (target) => e.draw('metal', target, { uZones: zones.map, uH: heightMap, uHb: hPyramid[1] }, { uWear: p.metalWear, uSharp: p.metalSharp });
      return slotMap(p, 'metallic', e.rt('metal', e.width, e.height, 'r8'), makeMetal, p.addMetalDetail, p.metalDetailAmount, p.metalDetailSize);
    });

    const opacity = stage('opacity', params, ['shape', 'zones', 'in:opacity'], (p) => {
      const target = e.rt('opacity', e.width, e.height, 'r8');
      const slot = p.slots.opacity;
      if (slot.mode === 'flat') {
        e.draw('fill', target, {}, { uColor: [slot.flat, slot.flat, slot.flat, 1] });
        return target;
      }
      const useLoaded = slot.mode === 'load' && loaded.opacity;
      e.draw('opacity', target, { uH: heightMap, uHb: hPyramid[1], uZones: zones.map, uLoaded: useLoaded ? loaded.opacity : albedo }, {
        uEdge: p.opacityEdge, uRagged: p.opacityRagged, uPatch: p.opacityPatch,
        uCrack: p.opacityCrack, uUseLoaded: useLoaded ? 1 : 0,
      });
      return target;
    });

    // Each map's levels and curve run last, so dragging them reruns only this pass.
    const adjusted = (name, slot, src, color) => stage('remap:' + name, params, [name === 'albedo' ? 'shape' : name], (p) => remap(name, src, p['adjust:' + slot], color));

    const lin = (params.flatColor || [1, 1, 1]).map(srgbToLinear);
    if (params.slots.albedo.mode === 'flat') {
      const flatAlbedo = e.rt('albedoF', e.width, e.height);
      e.draw('fill', flatAlbedo, {}, { uColor: [lin[0], lin[1], lin[2], 1] });
      finals.albedo = flatAlbedo;
      e.tint = [1, 1, 1];
    } else {
      finals.albedo = adjusted('albedo', 'albedo', albedo, true);
      e.tint = lin;
    }
    finals.height = heightMap;
    finals.normal = normal;
    finals.ao = adjusted('ao', 'ao', ao, false);
    finals.rough = adjusted('rough', 'roughness', rough, false);
    finals.metal = adjusted('metal', 'metallic', metal, false);
    finals.opacity = adjusted('opacity', 'opacity', opacity, false);
    finals.photo = alb.photo;
    e.terrain = params.kind === 'terrain'
      ? stage('terrain', params, ['shape', 'remap:albedo', 'remap:rough', 'remap:ao', 'in:layer'], (p) => terrainStage(p, hPyramid))
      : null;
    mipped.clear();
    zoneInput = zones;
    detailInput = shape.drawDetail;
    shown.zones = null;
    shown.detail = null;

    // Keep the stage outputs and the sky; scratch and view targets are freed.
    const keep = new Set([...Object.values(finals), ...Object.values(e.terrain || {}), alb.photo, alb.albSource, alb.albedo, ...alb.pyramid, heightMap, ...hPyramid, normal, albedo, ao, zones.map, zones.src, rough, metal, opacity]);
    rts.forEach((target, name) => {
      if (!keep.has(target) && !name.startsWith('env') && !name.startsWith('hold')) e.freeTarget(name);
    });
    flushRetired();
    return warnings;
  }

  // Retained maps of the layer that is not on screen. Names starting with hold survive the free pass.
  const held = { detail: null, macro: null };
  let layerName = 'detail';
  let useHeldFlag = true;
  let layerToken = 0;

  function bumpLayer() {
    layerToken += 1;
    versions['in:layer'] = layerToken;
  }

  let holdSerial = 0;
  const retired = [];

  function copyOf(src) {
    const out = e.rt('hold' + (holdSerial++), src.w, src.h, src.format || 'rgba8');
    e.draw('copy', out, { uTex: src }, { uFlip: 0, uGray: 0 });
    return out;
  }

  // A texture the current frame still samples stays until the next update replaces it.
  function freeBag(bag) {
    const live = new Set([...Object.values(e.terrain || {}), ...Object.values(finals)]);
    Object.keys(bag).forEach((key) => {
      if (live.has(bag[key])) retired.push(bag[key]);
      else e.freeTarget(bag[key].name);
    });
  }

  function flushRetired() {
    const live = new Set([...Object.values(e.terrain || {}), ...Object.values(finals)]);
    for (let i = retired.length - 1; i >= 0; i--) {
      if (live.has(retired[i])) continue;
      e.freeTarget(retired[i].name);
      retired.splice(i, 1);
    }
  }

  function dropHeld(which) {
    const bag = held[which];
    if (!bag) return;
    held[which] = null;
    freeBag(bag);
    bumpLayer();
  }

  function holdLayer(which) {
    if (!e.terrain || !finals.albedo || !finals.normal) return;
    const bag = which === 'detail'
      ? {
        albedo: copyOf(finals.albedo),
        normal: copyOf(finals.normal),
        baseD: copyOf(e.terrain.baseD),
        detB: copyOf(e.terrain.detB),
        detD: copyOf(e.terrain.detD),
      }
      : {
        macB: copyOf(e.terrain.macB),
        macN: copyOf(e.terrain.macN),
        macD: copyOf(e.terrain.macD),
      };
    const previous = held[which];
    held[which] = bag;
    if (previous) freeBag(previous);
    bumpLayer();
  }

  function setLayer(name) {
    if (layerName === name) return;
    layerName = name;
    bumpLayer();
  }

  function useHeld(on) {
    if (useHeldFlag === on) return;
    useHeldFlag = on;
    bumpLayer();
  }

  function clearHeld() {
    held.detail = null;
    held.macro = null;
    retired.length = 0;
  }

  // Terrain detail and macro textures: signed overlays around 0.5 of the finished maps. Detail keeps what
  // the widest blur removes. An automatic macro is that blur against the image mean, at half size. A macro
  // layer with its own photo is recentred on its own average, at full size, with its own normal.
  function terrainStage(p, hPyramid) {
    // The flat albedo is drawn outside the stages; reading its inputs reruns this stage when they change.
    void [p.slots, p.flatColor];
    const w = e.width;
    const h = e.height;
    const mw = Math.max(1, w >> 1);
    const mh = Math.max(1, h >> 1);
    const baseD = e.rt('tBaseD', w, h);
    e.draw('tpack', baseD, { uR: finals.rough, uAO: finals.ao, uH: finals.height }, {});
    const aBlur = e.blurPyramid(finals.albedo, 'ta')[3];
    const dBlur = e.blurPyramid(baseD, 'td')[3];
    // Each pyramid pass keeps 0.8594594 of the brightness, so level 3 (8 passes) is scaled back up.
    const blurGain = 1 / Math.pow(0.8594594, 8);
    const recenter = (name, tw, th, src, blur, mean, srcGain) => {
      const out = e.rt(name, tw, th);
      e.draw('recenter', out, { uTex: src, uBlur: blur || src }, {
        uMean: mean ? [...mean, 0] : [0, 0, 0, 0], uUseMean: mean ? 1 : 0, uSrcGain: srcGain, uBlurGain: blurGain,
      });
      return out;
    };
    const out = {};
    const heldDetail = useHeldFlag && layerName === 'macro' ? held.detail : null;
    if (heldDetail) {
      out.baseB = heldDetail.albedo;
      out.baseN = heldDetail.normal;
      out.baseD = heldDetail.baseD;
      out.detB = heldDetail.detB;
      out.detD = heldDetail.detD;
      out.detN = heldDetail.normal;
    } else {
      out.baseB = finals.albedo;
      out.baseN = finals.normal;
      out.baseD = baseD;
      out.detB = recenter('tDetB', w, h, finals.albedo, aBlur, null, 1);
      out.detD = recenter('tDetD', w, h, baseD, dBlur, null, 1);
      out.detN = finals.normal;
    }
    const heldMacro = useHeldFlag && layerName === 'detail' ? held.macro : null;
    if (heldMacro) {
      out.macB = heldMacro.macB;
      out.macN = heldMacro.macN;
      out.macD = heldMacro.macD;
    } else if (layerName === 'macro') {
      out.macB = recenter('tMacB', w, h, finals.albedo, null, e.meanOf(finals.albedo), 1);
      out.macD = recenter('tMacD', w, h, baseD, null, e.meanOf(baseD), 1);
      out.macN = e.rt('tMacN', w, h);
      e.draw('copy', out.macN, { uTex: finals.normal }, { uFlip: 0, uGray: 0 });
    } else {
      out.macB = recenter('tMacB', mw, mh, aBlur, null, e.meanOf(finals.albedo), blurGain);
      out.macD = recenter('tMacD', mw, mh, dBlur, null, e.meanOf(baseD), blurGain);
      out.macN = e.rt('tMacN', mw, mh);
      const wide = hPyramid[3];
      e.draw('normal', out.macN, { uH: wide, uB0: wide, uB1: wide, uB2: wide }, {
        uTexel: [1 / wide.w, 1 / wide.h], uBand: [0, 0, 0, 1], uStrength: p.normalStrength, uFlip: p.flipY ? 1 : 0,
      });
    }
    return out;
  }

  // The zone and detail views are only drawn while they are shown.
  let zoneInput = null;
  let detailInput = null;
  const shown = { zones: null, detail: null };
  function viewTarget(view) {
    if (view === 'zones' && !shown.zones && zoneInput) {
      shown.zones = e.rt('zoneView', e.width, e.height);
      e.draw('zones', shown.zones, { uTex: zoneInput.src }, { ...zoneInput.uniforms, uShow: 1 });
    }
    if (view === 'detail' && !shown.detail && detailInput) {
      shown.detail = e.rt('detailView', e.width, e.height);
      detailInput(shown.detail);
    }
    return shown[view];
  }

  Object.assign(e, { setSource, setLoaded, setMask, uploadKey, update, viewTarget, forgetStages, stageRuns, holdLayer, dropHeld, useHeld, setLayer, clearHeld });
}
