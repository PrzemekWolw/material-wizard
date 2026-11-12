import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readProject, zipStore } from '../src/export.js';
import { gotoApp, keepDrawingBuffer, openCanvas, painted, settled } from './helpers.js';

function drawStones(c) {
  c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let y = 0; y < 256; y += 16) {
    for (let x = 0; x < 256; x += 16) {
      g.fillStyle = 'rgb(' + (80 + ((x * 5 + y * 3) % 100)) + ',' + (70 + ((x + y * 7) % 60)) + ',60)';
      g.fillRect(x, y, 16, 16);
    }
  }
}

async function openProjectFile(page, bytes, name) {
  await page.locator('#open-any').evaluate((input, { list, name }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(list)], name, { type: 'application/x-material-wizard' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { list: [...bytes], name });
}

function mapHashes(page) {
  return page.evaluate(async () => {
    const { engine } = await import('./src/modules/render.js');
    const out = {};
    for (const name of ['albedo', 'normal', 'rough', 'ao']) {
      const map = engine.readMap(name);
      let h = 0;
      for (let i = 0; i < map.rgba.length; i++) h = (h * 31 + map.rgba[i]) | 0;
      out[name] = map.w + 'x' + map.h + ':' + h;
    }
    return out;
  });
}

async function save(page) {
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  return readFile(await download.path());
}

test.beforeEach(({ page }) => keepDrawingBuffer(page));

test('a project from an older version opens', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await gotoApp(page);
  await openProjectFile(page, await readFile(new URL('./fixtures/old-1.0.mwz', import.meta.url)), 'old-1.0.mwz');
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  await page.waitForFunction(painted, null, { timeout: 15000 });
  expect(await page.locator('[data-param="name"]').inputValue()).toBe('oldstone');
  expect(await page.locator('[data-param="aoDetailSize"]').inputValue()).toBe('0.3');
  expect(await page.locator('[data-slot-mode="normal"]').inputValue()).toBe('load');
  expect(await page.evaluate(() => [document.querySelector('[data-param="kind"]').value, document.body.dataset.kind])).toEqual(['regular', 'regular']);
  expect(errors).toEqual([]);
});

test('a saved project reopens with identical maps and the loaded file bytes', async ({ page }) => {
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  const normalPng = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(128,128,255)';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgb(180,100,230)';
    g.fillRect(16, 16, 32, 32);
    return [...new Uint8Array(await (await new Promise((resolve) => c.toBlob(resolve, 'image/png'))).arrayBuffer())];
  });
  await page.locator('[data-slot-file="normal"]').evaluate((input, list) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(list)], 'n.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, normalPng);
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const before = await mapHashes(page);
  const saved = await save(page);
  const project = await readProject(saved);
  expect(Buffer.from(project.files['maps/normal.png'])).toEqual(Buffer.from(normalPng));
  await gotoApp(page);
  await openProjectFile(page, saved, 'saved.mwz');
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  expect(await mapHashes(page)).toEqual(before);
});

test('deep undo after several crops restores each photo', async ({ page }) => {
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  const sizes = await page.evaluate(async () => {
    const { state } = await import('./src/services/state.js');
    const out = [state.original.width];
    for (let i = 0; i < 5; i++) {
      state.adjustFrame = '0.1,0.1,0.8,0.8';
      document.getElementById('apply-crop').click();
      out.push(state.original.width);
    }
    return out;
  });
  expect(sizes).toEqual([256, 205, 164, 131, 105, 84]);
  await page.waitForTimeout(500);
  const undone = await page.evaluate(async () => {
    const { state } = await import('./src/services/state.js');
    const history = await import('./src/services/history.js');
    const packed = history.undoStack.filter((snap) => snap.packed).length;
    const out = [];
    for (let i = 0; i < 5; i++) {
      await history.undo();
      out.push(state.original.width);
    }
    return { packed, out };
  });
  expect(undone.packed).toBe(3);
  expect(undone.out).toEqual([105, 131, 164, 205, 256]);
  await settled(page);
  expect(await page.evaluate(painted)).toBe(true);
});

test('undo history has no step limit and survives a saved project', async ({ page }) => {
  test.setTimeout(90000);
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  const steps = await page.evaluate(async () => {
    const { state } = await import('./src/services/state.js');
    const history = await import('./src/services/history.js');
    state.adjustFrame = '0.1,0.1,0.8,0.8';
    document.getElementById('apply-crop').click();
    const el = document.querySelector('[data-param="delight"]');
    for (let i = 0; i < 40; i++) {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.value = (0.2 + i * 0.02).toFixed(2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await history.undo();
    return { undo: history.undoStack.length, redo: history.redoStack.length };
  });
  expect(steps).toEqual({ undo: 41, redo: 1 });
  await expect.poll(() => page.evaluate(async () => {
    const { undoStack } = await import('./src/services/history.js');
    const cropped = undoStack.slice(2, -3);
    if (!cropped.every((snap) => snap.packed)) return 0;
    return new Set(cropped.map((snap) => snap.original)).size;
  }), { timeout: 30000 }).toBe(1);

  const saved = await save(page);
  const project = await readProject(saved);
  expect(project.history.undo.length).toBe(41);
  expect(project.history.redo.length).toBe(1);
  expect(Object.keys(project.files).filter((name) => name.startsWith('history/img/')).length).toBe(1);
  expect(project.history.undo[2].photo).toBe('photo.png');
  expect(project.session.view.tab).toBeTruthy();

  await gotoApp(page);
  await openProjectFile(page, saved, 'saved.mwz');
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  const restored = await page.evaluate(async () => {
    const { state } = await import('./src/services/state.js');
    const history = await import('./src/services/history.js');
    const delight = () => document.querySelector('[data-param="delight"]').value;
    const out = { undo: history.undoStack.length, redo: history.redoStack.length, width: state.original.width, now: delight() };
    await history.redo();
    out.redone = delight();
    await history.undo();
    await history.undo();
    out.undone = delight();
    while (history.undoStack.length > 1) await history.undo();
    out.first = state.original.width;
    return out;
  });
  expect(restored).toEqual({ undo: 41, redo: 1, width: 205, now: '0.96', redone: '0.98', undone: '0.94', first: 256 });
  await settled(page);
  expect(await page.evaluate(painted)).toBe(true);
});

test('a broken history in a project is left out', async ({ page }) => {
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  const saved = await save(page);
  const project = await readProject(saved);
  const session = { ...project.session, history: { v: 1, undo: [{ photo: 'history/img/7.png', slots: {}, lights: [] }], redo: [] } };
  const files = Object.entries(project.files).map(([name, data]) => ({ name, data: name === 'session.json' ? new TextEncoder().encode(JSON.stringify(session)) : data }));
  const broken = await zipStore(files);
  await gotoApp(page);
  await openProjectFile(page, broken, 'broken.mwz');
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  expect(await page.evaluate(async () => (await import('./src/services/history.js')).undoStack.length)).toBe(0);
  await page.waitForFunction(() => document.querySelector('#warnings').textContent.includes('undo history'));
});

test('an 8192 export keeps the heap low', async ({ page }) => {
  test.setTimeout(240000);
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await page.evaluate(() => {
    const size = document.querySelector('[data-param="size"]');
    size.value = '8192';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    window.reads = [];
    const readPixels = WebGL2RenderingContext.prototype.readPixels;
    WebGL2RenderingContext.prototype.readPixels = function (x, y, w, h, format, type, buf) {
      if (w * h > 1 << 20) window.reads.push(buf.byteLength);
      return readPixels.apply(this, arguments);
    };
    window.heapPeak = 0;
    setInterval(() => { window.heapPeak = Math.max(window.heapPeak, performance.memory.usedJSHeapSize); }, 20);
    delete window.showSaveFilePicker;
  });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 230000 }), page.keyboard.press('Control+e')]);
  const zip = await readFile(await download.path());
  const { peakMB, reads } = await page.evaluate(() => ({ peakMB: Math.round(window.heapPeak / 1048576), reads: window.reads.map((n) => n / 1048576) }));
  console.log('export8192 ' + JSON.stringify({ peakMB, reads, zipMB: Math.round(zip.length / 1048576) }));
  // One readback per map: base color and normal as RGBA, the three gray maps packed to one byte per pixel.
  expect(reads).toEqual([256, 256, 64, 64, 64]);
  expect(peakMB).toBeLessThan(100);
});

test('a jpeg project keeps the original photo bytes', async ({ page }) => {
  await gotoApp(page);
  const files = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const image = g.createImageData(256, 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        image.data[i] = x;
        image.data[i + 1] = y;
        image.data[i + 2] = 90;
        image.data[i + 3] = 255;
      }
    }
    g.putImageData(image, 0, 0);
    const jpeg = new Uint8Array(await (await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.7))).arrayBuffer());
    const png = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    return { jpeg: [...jpeg], png: png.size };
  });
  await page.locator('#open-file').evaluate((input, list) => {
    const file = new File([Uint8Array.from(list)], 'noise.jpg', { type: 'image/jpeg' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, files.jpeg);
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  const saved = await readFile(await download.path());
  const project = await readProject(saved);
  expect(project.session.photo).toBe('photo.jpg');
  expect(Buffer.from(project.files['photo.jpg'])).toEqual(Buffer.from(files.jpeg));
  expect(saved.length).toBeLessThan(files.jpeg.length + 2048);
});
