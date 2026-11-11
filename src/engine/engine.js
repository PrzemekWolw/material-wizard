import { VS } from '../shaders/common.glsl.js';
import { BASIC } from '../shaders/basic.glsl.js';
import { ALBEDO } from '../shaders/albedo.glsl.js';
import { SURFACE } from '../shaders/surface.glsl.js';
import { SKY } from '../shaders/sky.glsl.js';
import { LIT } from '../shaders/lit.glsl.js';
import { POST } from '../shaders/post.glsl.js';
import { TERRAIN } from '../shaders/terrain.glsl.js';
import { addTargets } from './targets.js';
import { addFields } from './fields.js';
import { addMaps } from './maps.js';
import { addSky } from './sky.js';
import { addLit } from './lit.js';
import { addHdr } from './hdr.js';

export { CLASSES } from './classes.js';

const FS = { ...BASIC, ...ALBEDO, ...SURFACE, ...SKY, ...LIT, ...POST, ...TERRAIN };

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return shader;
}

// Linking starts here; the status is checked on first use, so with KHR_parallel_shader_compile it does not block.
function startProgram(gl, fs) {
  const prog = gl.createProgram();
  const shaders = [compile(gl, gl.VERTEX_SHADER, VS), compile(gl, gl.FRAGMENT_SHADER, fs)];
  shaders.forEach((shader) => gl.attachShader(prog, shader));
  gl.linkProgram(prog);
  return { prog, shaders };
}

function finishProgram(gl, { prog, shaders }) {
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(shaders.map((shader) => gl.getShaderInfoLog(shader)).join('\n') || gl.getProgramInfoLog(prog) || 'link');
  }
  shaders.forEach((shader) => gl.deleteShader(shader));
  return prog;
}

export function createEngine(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is required');
  const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const progs = {};
  const pending = {};
  if (gl.getExtension('KHR_parallel_shader_compile')) Object.keys(FS).forEach((name) => { pending[name] = startProgram(gl, FS[name]); });
  function program(name) {
    if (!progs[name]) {
      progs[name] = finishProgram(gl, pending[name] || startProgram(gl, FS[name]));
      delete pending[name];
    }
    return progs[name];
  }

  const rts = new Map();
  const loaded = {};
  const warnings = [];
  const finals = {};
  const mipped = new Set();

  const e = {
    gl, canvas, floatOk, program, rts, loaded, warnings, finals, mipped,
    width: 0,
    height: 0,
    screenW: 0,
    screenH: 0,
    sourceTex: null,
    maskTex: null,
    skyKey: '',
    skyUp: [0, 0, 0],
    skyViewKey: '',
    skyViewTex: null,
    shownScale: null,
    exposureTime: 0,
    meterTarget: 1,
    accumulating: false,
    busy: false,
    onFrame: null,
    liveParams: null,
    hdrFrameBuf: null,
    hdrReadFailed: false,
    factors: { roughness: 1, metallic: 1, opacity: 1, normal: 1 },
    tint: [1, 1, 1],
    terrain: null,
    wrapS: gl.CLAMP_TO_EDGE,
    wrapT: gl.CLAMP_TO_EDGE,
  };
  addTargets(e);
  addFields(e);
  addMaps(e);
  addSky(e);
  addLit(e);
  addHdr(e);

  function resize(w, h) {
    e.width = w;
    e.height = h;
    e.screenW = w;
    e.screenH = h;
    canvas.width = w;
    canvas.height = h;
  }

  // RGBA, or with gray the packed R channel ({ gray, stride }) of a single-channel map.
  function readMap(name, gray = false) {
    const target = name === 'source' ? finals.photo : finals[name];
    if (!target) return null;
    if (gray) return { ...e.readGray(target), w: e.width, h: e.height };
    if (name === 'albedo') {
      const shown = e.rt('tmpA', e.width, e.height);
      e.draw('show', shown, { uTex: target, uBefore: target }, { uSplit: 0, uMode: 0, uRepeatX: 1, uRepeatY: 1, uSeam: 0, uZoom: 1, uCenter: [0.5, 0.5], uMul: [1, 1, 1] });
      return { rgba: e.read(shown), w: e.width, h: e.height };
    }
    return { rgba: e.read(target), w: e.width, h: e.height };
  }

  // A terrain texture at its own size, as RGBA or with channel >= 0 that channel packed as gray.
  function readTerrain(key, channel = -1) {
    const target = e.terrain && e.terrain[key];
    if (!target) return null;
    if (channel >= 0) return { ...e.readGray(target, channel), w: target.w, h: target.h };
    return { rgba: e.read(target), w: target.w, h: target.h };
  }

  function release() {
    e.clearHeld();
    rts.forEach((target) => {
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fb);
    });
    rts.clear();
    e.forgetStages();
    e.dropHdr();
    e.skyKey = '';
    Object.keys(loaded).forEach((key) => {
      if (loaded[key]) gl.deleteTexture(loaded[key]);
      loaded[key] = null;
    });
    if (e.sourceTex) gl.deleteTexture(e.sourceTex);
    if (e.maskTex) gl.deleteTexture(e.maskTex);
    e.sourceTex = null;
    e.maskTex = null;
    Object.keys(finals).forEach((key) => delete finals[key]);
    gl.getError();
  }

  function maxSize() {
    return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 4096;
  }

  return {
    setSource: e.setSource, setLoaded: e.setLoaded, setMask: e.setMask, uploadKey: e.uploadKey, update: e.update, present: e.present, thumbnails: e.thumbnails, resize, readMap, readTerrain, warnings, release, maxSize,
    holdLayer: e.holdLayer, dropHeld: e.dropHeld, useHeld: e.useHeld, setLayer: e.setLayer,
    stageRuns: () => ({ ...e.stageRuns }),
    targetBytes: e.targetBytes,
    hdrFrame() { return e.hdrFrameBuf; },
    onFrame(fn) { e.onFrame = fn; },
    accumulating() { return e.accumulating; },
    // While busy (an export reads maps at output size), the canvas is not presented.
    setBusy(on) { e.busy = on; },
    hdrFailed() { return e.hdrReadFailed; },
    lost() { return gl.isContextLost(); },
    size() { return { w: e.width, h: e.height }; },
  };
}
