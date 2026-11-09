import { homographyFromQuad } from './tile.js';

const SIDES = ['left', 'right', 'up', 'down'];
const KNOB = 7;
const CORNER = 9;
const HANDLE = 9;
const MIN_FRAME = 0.02;
const FADE_STEPS = 2000;
const AXIS_COLOR = { left: '#38bdf8', right: '#38bdf8', up: '#facc15', down: '#facc15' };

// Zoom needed so a w x h picture turned by deg still covers the whole w x h area.
export function coverScale(w, h, deg) {
  const a = Math.abs(deg) * Math.PI / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

// state: { base, frame, sides, ratio, tile, view: 'frame' | 'tiled', size, labels }
//   or { base, view: 'frame', fix: { mode: 'rotate' | 'quad', angle, quad, full, result, labels } }
// hooks: onStart(), onFrame(frame), onFade(side, key, value), onQuad(quad), onAngle(deg), onEnd(), onView(view)
export function createTileEditor(wrap, hooks) {
  const canvas = document.createElement('canvas');
  canvas.className = 'mw-tile-edit';
  canvas.hidden = true;
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let state = null;
  let drag = null;
  let raf = 0;
  const view = { zoom: 1, x: 0.5, y: 0.5 };
  const zoomInput = document.getElementById('tile-zoom');

  function fit() {
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const pad = 28;
    let bw;
    let bh;
    if (state.view === 'tiled' && state.frame) {
      const n = 3;
      const tw = state.tile ? state.tile.width : state.frame.w * state.base.width;
      const th = state.tile ? state.tile.height : state.frame.h * state.base.height;
      const scale = Math.min((cw - pad * 2) / (tw * n), (ch - pad * 2) / (th * n));
      bw = tw * scale * n;
      bh = th * scale * n;
    } else {
      const scale = Math.min((cw - pad * 2) / state.base.width, (ch - pad * 2) / state.base.height);
      bw = state.base.width * scale;
      bh = state.base.height * scale;
    }
    const w = bw * view.zoom;
    const h = bh * view.zoom;
    return { x: cw / 2 - view.x * w, y: ch / 2 - view.y * h, w, h };
  }

  function clampView() {
    const half = 0.5 / view.zoom;
    view.x = Math.min(1 - half, Math.max(half, view.x));
    view.y = Math.min(1 - half, Math.max(half, view.y));
  }

  function setZoom(next, anchor) {
    if (!state) return;
    const zoom = Math.min(8, Math.max(1, next));
    if (anchor) {
      const img = fit();
      const u = (anchor.x - img.x) / img.w;
      const v = (anchor.y - img.y) / img.h;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      const newW = img.w * zoom / view.zoom;
      const newH = img.h * zoom / view.zoom;
      view.x = u - (anchor.x - cw / 2) / newW;
      view.y = v - (anchor.y - ch / 2) / newH;
    }
    view.zoom = zoom;
    clampView();
    if (zoomInput && document.activeElement !== zoomInput) zoomInput.value = String(view.zoom);
    if (zoomInput) zoomInput.style.setProperty('--fill', ((view.zoom - 1) / 7) * 100 + '%');
    request();
  }

  function frameRect(img) {
    const f = state.frame;
    return { x: img.x + f.x * img.w, y: img.y + f.y * img.h, w: f.w * img.w, h: f.h * img.h };
  }

  function knobs(fr) {
    const out = [];
    SIDES.forEach((side) => {
      const s = state.sides[side];
      if (!s.on) return;
      ['a', 'b'].forEach((key, i) => {
        const along = i === 0 ? 0.38 : 0.62;
        const v = s[key];
        if (side === 'left') out.push({ side, key, x: fr.x + v * fr.w, y: fr.y + fr.h * along });
        if (side === 'right') out.push({ side, key, x: fr.x + fr.w - v * fr.w, y: fr.y + fr.h * along });
        if (side === 'up') out.push({ side, key, x: fr.x + fr.w * along, y: fr.y + v * fr.h });
        if (side === 'down') out.push({ side, key, x: fr.x + fr.w * along, y: fr.y + fr.h - v * fr.h });
      });
    });
    return out;
  }

  function corners(fr) {
    return [
      { cx: 0, cy: 0, x: fr.x, y: fr.y },
      { cx: 1, cy: 0, x: fr.x + fr.w, y: fr.y },
      { cx: 1, cy: 1, x: fr.x + fr.w, y: fr.y + fr.h },
      { cx: 0, cy: 1, x: fr.x, y: fr.y + fr.h },
    ];
  }

  function beyond(img, fr, side) {
    const b = state.sides[side].b;
    let r;
    if (side === 'left') r = { x: fr.x + fr.w, y: fr.y, w: b * fr.w, h: fr.h };
    if (side === 'right') r = { x: fr.x - b * fr.w, y: fr.y, w: b * fr.w, h: fr.h };
    if (side === 'up') r = { x: fr.x, y: fr.y + fr.h, w: fr.w, h: b * fr.h };
    if (side === 'down') r = { x: fr.x, y: fr.y - b * fr.h, w: fr.w, h: b * fr.h };
    const x0 = Math.max(img.x, r.x);
    const y0 = Math.max(img.y, r.y);
    const x1 = Math.min(img.x + img.w, r.x + r.w);
    const y1 = Math.min(img.y + img.h, r.y + r.h);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  function draw() {
    raf = 0;
    if (!state || canvas.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(wrap);
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(0, 0, cw, ch);
    if (state.fix) drawFix(cw, ch, style);
    else if (state.view === 'tiled') drawTiled();
    else drawFrame();
    if (state.off && !state.fix && state.labels && state.labels.off) pill(state.labels.off, cw / 2, 18, '#fff');
  }

  function quadPoints(img) {
    const q = state.fix.quad;
    return [0, 1, 2, 3].map((i) => ({ index: i, x: img.x + q[i * 2] * img.w, y: img.y + q[i * 2 + 1] * img.h }));
  }

  function line(a, b) {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }

  function strokeGrid(draw) {
    ctx.save();
    ctx.beginPath();
    draw();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function drawFix(cw, ch, style) {
    const fix = state.fix;
    const labels = fix.labels || {};
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f15a22';
    const img = fit();
    const base = state.base;
    if (fix.mode === 'rotate') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(img.x, img.y, img.w, img.h);
      ctx.clip();
      ctx.translate(img.x + img.w / 2, img.y + img.h / 2);
      ctx.rotate(fix.angle * Math.PI / 180);
      const s = coverScale(img.w, img.h, fix.angle);
      ctx.scale(s, s);
      ctx.drawImage(base, -img.w / 2, -img.h / 2, img.w, img.h);
      ctx.restore();
      const n = 8;
      strokeGrid(() => {
        for (let i = 1; i < n; i++) {
          line({ x: img.x + img.w * i / n, y: img.y }, { x: img.x + img.w * i / n, y: img.y + img.h });
          line({ x: img.x, y: img.y + img.h * i / n }, { x: img.x + img.w, y: img.y + img.h * i / n });
        }
      });
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(img.x, img.y, img.w, img.h);
      if (labels.angle) pill(labels.angle, img.x + img.w / 2, img.y + 18, '#fff');
      return;
    }
    ctx.drawImage(base, img.x, img.y, img.w, img.h);
    const pts = quadPoints(img);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(img.x, img.y, img.w, img.h);
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
    const m = homographyFromQuad(fix.quad);
    const map = (u, v) => {
      const d = m[6] * u + m[7] * v + m[8];
      return { x: img.x + ((m[0] * u + m[1] * v + m[2]) / d) * img.w, y: img.y + ((m[3] * u + m[4] * v + m[5]) / d) * img.h };
    };
    strokeGrid(() => {
      for (let i = 1; i < 4; i++) {
        line(map(i / 4, 0), map(i / 4, 1));
        line(map(0, i / 4), map(1, i / 4));
      }
    });
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    pts.forEach((p) => {
      const on = (drag && drag.index === p.index) || hoverHandle === p.index;
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE, 0, Math.PI * 2);
      ctx.fillStyle = on ? accent : 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.strokeStyle = on ? '#fff' : accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    });
    if (fix.result && !drag) {
      const size = Math.round(Math.min(cw, ch) * 0.3);
      const aspect = fix.result.width / fix.result.height;
      const iw = aspect >= 1 ? size : size * aspect;
      const ih = aspect >= 1 ? size / aspect : size;
      const ix = cw - iw - 10;
      const iy = ch - ih - 10;
      ctx.drawImage(fix.result, ix, iy, iw, ih);
      ctx.strokeStyle = style.borderTopColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
      if (labels.result) pill(labels.result, ix + iw - 6, iy + 16, '#fff', 'right');
    }
    if (drag && drag.kind === 'quad') drawLoupe(pts[drag.index], img, cw, ch, accent);
  }

  function drawLoupe(p, img, cw, ch, accent) {
    const full = state.fix.full || state.base;
    const r = 60;
    const zoom = 4;
    const gap = 80;
    const lx = p.x + gap + r > cw ? p.x - gap : p.x + gap;
    const ly = p.y - gap - r < 0 ? p.y + gap : p.y - gap;
    const sx = ((p.x - img.x) / img.w) * full.width;
    const sy = ((p.y - img.y) / img.h) * full.height;
    const sw = (r * 2 / zoom) * (full.width / img.w);
    const sh = (r * 2 / zoom) * (full.height / img.h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(lx - r, ly - r, r * 2, r * 2);
    ctx.drawImage(full, sx - sw / 2, sy - sh / 2, sw, sh, lx - r, ly - r, r * 2, r * 2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    line({ x: lx - r, y: ly }, { x: lx - 4, y: ly });
    line({ x: lx + 4, y: ly }, { x: lx + r, y: ly });
    line({ x: lx, y: ly - r }, { x: lx, y: ly - 4 });
    line({ x: lx, y: ly + 4 }, { x: lx, y: ly + r });
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(lx, ly, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  let hoverHandle = -1;

  function hitFix(p) {
    const img = fit();
    if (state.fix.mode === 'quad') {
      let best = null;
      quadPoints(img).forEach((q) => {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d <= HANDLE + 6 && (!best || d < best.d)) best = { d, index: q.index };
      });
      return best ? { kind: 'quad', index: best.index } : null;
    }
    if (p.x >= img.x && p.x <= img.x + img.w && p.y >= img.y && p.y <= img.y + img.h) return { kind: 'rotate' };
    return null;
  }

  function pill(label, x, y, color, align) {
    ctx.save();
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 12;
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(left, y - 10, w, 20);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, left + 6, y);
    ctx.restore();
  }

  // The blended tile, or the raw crop under the frame when there is none.
  function drawTile(x, y, w, h) {
    if (state.tile) { ctx.drawImage(state.tile, x, y, w, h); return; }
    const f = state.frame;
    const b = state.base;
    ctx.drawImage(b, f.x * b.width, f.y * b.height, f.w * b.width, f.h * b.height, x, y, w, h);
  }

  let cropCanvas = null;
  function tileSource() {
    if (state.tile) return state.tile;
    const f = state.frame;
    const b = state.base;
    const w = Math.max(1, Math.round(f.w * b.width));
    const h = Math.max(1, Math.round(f.h * b.height));
    if (!cropCanvas) cropCanvas = document.createElement('canvas');
    if (cropCanvas.width !== w || cropCanvas.height !== h) { cropCanvas.width = w; cropCanvas.height = h; }
    cropCanvas.getContext('2d').drawImage(b, f.x * b.width, f.y * b.height, f.w * b.width, f.h * b.height, 0, 0, w, h);
    return cropCanvas;
  }

  // One repeating pattern, so neighbouring copies share their edge pixels and no hairline shows between them.
  function drawTiled() {
    const n = 3;
    const grid = fit();
    const tw = grid.w / n;
    const th = grid.h / n;
    const ox = grid.x;
    const oy = grid.y;
    const src = tileSource();
    const pattern = ctx.createPattern(src, 'repeat');
    pattern.setTransform(new DOMMatrix().translateSelf(ox, oy).scaleSelf(tw / src.width, th / src.height));
    ctx.save();
    ctx.fillStyle = pattern;
    ctx.fillRect(ox, oy, grid.w, grid.h);
    ctx.restore();
    if (state.seamLines) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      for (let i = 1; i < n; i++) {
        ctx.moveTo(ox + i * tw, oy); ctx.lineTo(ox + i * tw, oy + th * n);
        ctx.moveTo(ox, oy + i * th); ctx.lineTo(ox + tw * n, oy + i * th);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function coverTint(fr, side) {
    const s = state.sides[side];
    const color = AXIS_COLOR[side];
    const horizontal = side === 'left' || side === 'right';
    const len = horizontal ? fr.w : fr.h;
    const a = s.a * len;
    const b = s.b * len;
    let x0, y0, x1, y1;
    if (side === 'left') { x0 = fr.x; y0 = fr.y; x1 = fr.x + b; y1 = fr.y; }
    if (side === 'right') { x0 = fr.x + fr.w; y0 = fr.y; x1 = fr.x + fr.w - b; y1 = fr.y; }
    if (side === 'up') { x0 = fr.x; y0 = fr.y; x1 = fr.x; y1 = fr.y + b; }
    if (side === 'down') { x0 = fr.x; y0 = fr.y + fr.h; x1 = fr.x; y1 = fr.y + fr.h - b; }
    if (b < 1) return;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, color + '40');
    g.addColorStop(Math.min(1, a / b), color + '40');
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    if (side === 'left') ctx.fillRect(fr.x, fr.y, b, fr.h);
    if (side === 'right') ctx.fillRect(fr.x + fr.w - b, fr.y, b, fr.h);
    if (side === 'up') ctx.fillRect(fr.x, fr.y, fr.w, b);
    if (side === 'down') ctx.fillRect(fr.x, fr.y + fr.h - b, fr.w, b);
  }

  function drawFrame() {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f15a22';
    const labels = state.labels || {};
    const img = fit();
    const fr = frameRect(img);
    const base = state.base;
    const sx = base.width / img.w;
    const sy = base.height / img.h;
    if (state.off) {
      ctx.drawImage(base, img.x, img.y, img.w, img.h);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(200,200,200,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);
      ctx.restore();
      ctx.fillStyle = 'rgba(200,200,200,0.8)';
      corners(fr).forEach((c) => ctx.fillRect(c.x - 5, c.y - 5, 10, 10));
      return;
    }
    ctx.globalAlpha = 0.3;
    ctx.drawImage(base, img.x, img.y, img.w, img.h);
    ctx.globalAlpha = 1;
    drawTile(fr.x, fr.y, fr.w, fr.h);
    const marked = (side) => !state.cover || state.cover[side] !== false;
    SIDES.forEach((side) => { if (state.sides[side].on && marked(side)) coverTint(fr, side); });
    SIDES.forEach((side) => {
      if (!state.sides[side].on || !marked(side)) return;
      const r = beyond(img, fr, side);
      if (r.w < 1 || r.h < 1) return;
      ctx.drawImage(base, (r.x - img.x) * sx, (r.y - img.y) * sy, r.w * sx, r.h * sy, r.x, r.y, r.w, r.h);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = AXIS_COLOR[side];
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      ctx.restore();
      if (labels.beyond && r.w > 40 && r.h > 24) pill(labels.beyond[side], r.x + r.w / 2, r.y + r.h / 2, AXIS_COLOR[side]);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);
    SIDES.forEach((side) => {
      const s = state.sides[side];
      if (!s.on) return;
      ['a', 'b'].forEach((key) => {
        ctx.save();
        ctx.strokeStyle = AXIS_COLOR[side];
        ctx.lineWidth = 1.5;
        if (key === 'b') ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const v = s[key];
        if (side === 'left') { ctx.moveTo(fr.x + v * fr.w, fr.y); ctx.lineTo(fr.x + v * fr.w, fr.y + fr.h); }
        if (side === 'right') { ctx.moveTo(fr.x + fr.w - v * fr.w, fr.y); ctx.lineTo(fr.x + fr.w - v * fr.w, fr.y + fr.h); }
        if (side === 'up') { ctx.moveTo(fr.x, fr.y + v * fr.h); ctx.lineTo(fr.x + fr.w, fr.y + v * fr.h); }
        if (side === 'down') { ctx.moveTo(fr.x, fr.y + fr.h - v * fr.h); ctx.lineTo(fr.x + fr.w, fr.y + fr.h - v * fr.h); }
        ctx.stroke();
        ctx.restore();
      });
    });
    ctx.fillStyle = accent;
    corners(fr).forEach((c) => ctx.fillRect(c.x - 5, c.y - 5, 10, 10));
    knobs(fr).forEach((k) => {
      const color = AXIS_COLOR[k.side];
      ctx.beginPath();
      ctx.arc(k.x, k.y, KNOB, 0, Math.PI * 2);
      ctx.fillStyle = k.key === 'a' ? color : '#111';
      ctx.fill();
      ctx.strokeStyle = k.key === 'a' ? '#111' : color;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
    if (labels.size) pill(labels.size, fr.x + fr.w - 6, fr.y + 16, '#fff', 'right');
  }

  function request() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function point(event) {
    const r = canvas.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  }

  function hit(p) {
    const img = fit();
    const fr = frameRect(img);
    const knob = !state.off && knobs(fr).find((k) => Math.hypot(p.x - k.x, p.y - k.y) <= KNOB + 3);
    if (knob) return { kind: 'knob', side: knob.side, key: knob.key };
    const corner = corners(fr).find((c) => Math.abs(p.x - c.x) <= CORNER && Math.abs(p.y - c.y) <= CORNER);
    if (corner) return { kind: 'corner', cx: corner.cx, cy: corner.cy };
    if (p.x >= fr.x && p.x <= fr.x + fr.w && p.y >= fr.y && p.y <= fr.y + fr.h) return { kind: 'move' };
    return null;
  }

  function cursorFor(target) {
    if (!target) return 'default';
    if (target.kind === 'move') return 'move';
    if (target.kind === 'corner') return target.cx === target.cy ? 'nwse-resize' : 'nesw-resize';
    return target.side === 'left' || target.side === 'right' ? 'ew-resize' : 'ns-resize';
  }

  function startPan(event, p) {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drag = { kind: 'pan', start: p, x: view.x, y: view.y, moved: false };
    canvas.style.cursor = 'grabbing';
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!state || event.button > 2) return;
    const p = point(event);
    const panButton = event.button === 1 || event.button === 2;
    if (state.fix) {
      const target = panButton ? null : hitFix(p);
      if (!target) {
        if (view.zoom > 1) startPan(event, p);
        return;
      }
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drag = Object.assign({ start: p, angle: state.fix.angle, quad: state.fix.quad.slice() }, target);
      canvas.style.cursor = 'grabbing';
      hooks.onStart();
      request();
      return;
    }
    if (!panButton && state.view === 'tiled' && view.zoom <= 1) {
      hooks.onView('frame');
      return;
    }
    const target = panButton || state.view === 'tiled' ? null : hit(p);
    if (!target) {
      if (view.zoom <= 1) return;
      startPan(event, p);
      return;
    }
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drag = Object.assign({ start: p, frame: Object.assign({}, state.frame) }, target);
    hooks.onStart();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!state) return;
    const p = point(event);
    if (state.fix && (!drag || drag.kind !== 'pan')) {
      if (!drag) {
        const target = hitFix(p);
        const next = target && target.kind === 'quad' ? target.index : -1;
        canvas.style.cursor = target ? 'grab' : (view.zoom > 1 ? 'grab' : 'default');
        if (next !== hoverHandle) { hoverHandle = next; request(); }
        return;
      }
      const img = fit();
      if (drag.kind === 'quad') {
        const q = drag.quad.slice();
        q[drag.index * 2] = Math.max(0, Math.min(1, (p.x - img.x) / img.w));
        q[drag.index * 2 + 1] = Math.max(0, Math.min(1, (p.y - img.y) / img.h));
        hooks.onQuad(q);
      } else {
        const cx = img.x + img.w / 2;
        const cy = img.y + img.h / 2;
        let turn = (Math.atan2(p.y - cy, p.x - cx) - Math.atan2(drag.start.y - cy, drag.start.x - cx)) * 180 / Math.PI;
        turn = ((turn + 540) % 360) - 180;
        hooks.onAngle(Math.round(Math.max(-45, Math.min(45, drag.angle + turn)) * 10) / 10);
      }
      return;
    }
    if (!drag) {
      const target = state.view === 'tiled' ? null : hit(p);
      canvas.style.cursor = state.view === 'tiled' ? (view.zoom > 1 ? 'grab' : 'pointer') : (target ? cursorFor(target) : (view.zoom > 1 ? 'grab' : 'default'));
      return;
    }
    if (drag.kind === 'pan') {
      const img = fit();
      view.x = drag.x - (p.x - drag.start.x) / img.w;
      view.y = drag.y - (p.y - drag.start.y) / img.h;
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) drag.moved = true;
      clampView();
      request();
      return;
    }
    const img = fit();
    const nx = (p.x - img.x) / img.w;
    const ny = (p.y - img.y) / img.h;
    const f = drag.frame;
    if (drag.kind === 'move') {
      const dx = (p.x - drag.start.x) / img.w;
      const dy = (p.y - drag.start.y) / img.h;
      hooks.onFrame({
        x: Math.max(0, Math.min(1 - f.w, f.x + dx)),
        y: Math.max(0, Math.min(1 - f.h, f.y + dy)),
        w: f.w,
        h: f.h,
      });
    } else if (drag.kind === 'corner') {
      const ax = drag.cx ? f.x : f.x + f.w;
      const ay = drag.cy ? f.y : f.y + f.h;
      const dirX = drag.cx ? 1 : -1;
      const dirY = drag.cy ? 1 : -1;
      const W = state.base.width;
      const H = state.base.height;
      let w = Math.max(MIN_FRAME, Math.abs(Math.max(0, Math.min(1, nx)) - ax)) * W;
      let h = Math.max(MIN_FRAME, Math.abs(Math.max(0, Math.min(1, ny)) - ay)) * H;
      if (state.ratio) {
        const r = state.ratio.a / state.ratio.b;
        w = Math.max(w, h * r);
        h = w / r;
      }
      const availW = (dirX > 0 ? 1 - ax : ax) * W;
      const availH = (dirY > 0 ? 1 - ay : ay) * H;
      const k = Math.min(1, availW / w, availH / h);
      w = w * k / W;
      h = h * k / H;
      hooks.onFrame({ x: dirX > 0 ? ax : ax - w, y: dirY > 0 ? ay : ay - h, w, h });
    } else {
      const fr = frameRect(img);
      let v;
      if (drag.side === 'left') v = (p.x - fr.x) / fr.w;
      if (drag.side === 'right') v = (fr.x + fr.w - p.x) / fr.w;
      if (drag.side === 'up') v = (p.y - fr.y) / fr.h;
      if (drag.side === 'down') v = (fr.y + fr.h - p.y) / fr.h;
      const s = state.sides[drag.side];
      const fm = state.frame;
      const room = { left: (1 - fm.x - fm.w) / fm.w, right: fm.x / fm.w, up: (1 - fm.y - fm.h) / fm.h, down: fm.y / fm.h }[drag.side];
      const max = Math.floor(Math.min(0.5, room) * FADE_STEPS + 1e-6) / FADE_STEPS;
      v = Math.max(0, Math.min(max, Math.round(v * FADE_STEPS) / FADE_STEPS));
      if (drag.key === 'a') v = Math.min(v, s.b);
      else v = Math.max(v, Math.min(s.a, max));
      hooks.onFade(drag.side, drag.key, v);
    }
  });

  const end = (event) => {
    if (!drag) return;
    const was = drag;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    drag = null;
    if (was.kind === 'pan') {
      canvas.style.cursor = view.zoom > 1 ? 'grab' : '';
      if (!was.moved && state && state.view === 'tiled') hooks.onView('frame');
      else request();
      return;
    }
    if (state && state.fix) canvas.style.cursor = 'grab';
    hooks.onEnd();
    request();
  };
  canvas.addEventListener('wheel', (event) => {
    if (!state) return;
    event.preventDefault();
    setZoom(view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), point(event));
  }, { passive: false });
  canvas.addEventListener('dblclick', (event) => {
    if (!state || view.zoom <= 1 || drag) return;
    const p = point(event);
    if (state.fix) {
      if (state.fix.mode === 'quad' && hitFix(p)) return;
      setZoom(1);
      return;
    }
    const target = state.view === 'tiled' ? null : hit(p);
    if (target && target.kind !== 'move') return;
    setZoom(1);
  });
  canvas.addEventListener('contextmenu', (event) => {
    if (view.zoom > 1) event.preventDefault();
  });
  if (zoomInput) zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  new ResizeObserver(request).observe(wrap);

  return {
    show(next) {
      state = next;
      canvas.hidden = !next;
      request();
    },
    dragging() { return !!drag; },
  };
}
