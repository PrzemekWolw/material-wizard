import { expect } from '@playwright/test';

export async function keepDrawingBuffer(page) {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      if (type === 'webgl2') options = { ...options, preserveDrawingBuffer: true };
      return getContext.call(this, type, options);
    };
  });
}

export async function countTextureBytes(page) {
  await page.addInitScript(() => {
    const live = new Map();
    const BYTES = { 0x881a: 8, 0x8814: 16, 0x8058: 4, 0x8c43: 4, 0x8229: 1, 0x822d: 2, 0x822b: 2, 0x822f: 4, 0x822e: 4, 0x8230: 8, 0x1908: 4 };
    const proto = WebGL2RenderingContext.prototype;
    const note = (gl, format, w, h) => {
      const tex = gl.getParameter(gl.TEXTURE_BINDING_2D);
      if (tex) live.set(tex, (BYTES[format] || 4) * w * h);
    };
    const texImage2D = proto.texImage2D;
    proto.texImage2D = function (target, level, format, w, h, ...rest) {
      const source = rest.length === 1 ? rest[0] : null;
      if (level === 0 && rest.length >= 4) note(this, format, w, h);
      else if (level === 0 && source) note(this, format, source.naturalWidth || source.width, source.naturalHeight || source.height);
      return texImage2D.apply(this, arguments);
    };
    const texStorage2D = proto.texStorage2D;
    proto.texStorage2D = function (target, levels, format, w, h) {
      note(this, format, w, h);
      return texStorage2D.apply(this, arguments);
    };
    const deleteTexture = proto.deleteTexture;
    proto.deleteTexture = function (tex) {
      live.delete(tex);
      return deleteTexture.apply(this, arguments);
    };
    window.textureBytes = () => [...live.values()].reduce((a, b) => a + b, 0);
  });
}

export async function openBytes(page, bytes, name, type = 'image/png') {
  await page.locator('#open-file').evaluate((input, { list, name, type }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(list)], name, { type }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { list: [...bytes], name, type });
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
}

export async function openCanvas(page, draw, name = 'sample.png', arg = null) {
  const bytes = await page.evaluate(async ({ draw, arg }) => {
    const c = document.createElement('canvas');
    // eslint-disable-next-line no-new-func
    new Function('c', 'arg', draw)(c, arg);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { draw: '(' + draw.toString() + ')(c, arg)', arg });
  await openBytes(page, bytes, name);
}

export function painted() {
  const c = document.querySelector('#view');
  const gl = c && c.getContext('webgl2');
  if (!gl || c.width < 2) return false;
  const px = new Uint8Array(4);
  gl.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px[0] + px[1] + px[2] > 8;
}

export async function setView(page, view) {
  await page.evaluate((value) => {
    const select = document.getElementById('view-mode');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, view);
}

export async function download(page, keys) {
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press(keys)]);
  return file;
}

// Waits until the lit view stops adding samples, so the canvas holds still.
export async function settled(page) {
  await page.waitForFunction(async () => !(await import('./src/modules/render.js')).engine.accumulating(), null, { timeout: 30000 });
}

// Fails a test on any uncaught page error or unhandled rejection.
// i18n awaits the locale at module top level, so load can fire before app.js has run its inits.
export async function gotoApp(page) {
  await page.goto('/index.html');
  await page.waitForSelector('#mw-tip', { state: 'attached' });
}

export function trackErrors(test) {
  let errors = [];
  test.beforeEach(({ page }) => {
    errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
  });
  test.afterEach(() => expect(errors).toEqual([]));
}
