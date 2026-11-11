import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readProject, unzipStore } from '../src/export.js';
import { download, gotoApp, keepDrawingBuffer, openCanvas, painted } from './helpers.js';

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

async function start(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/style.css')) errors.push(response.status() + ' ' + response.url()); });
  await keepDrawingBuffer(page);
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  return errors;
}

const kind = (page) => page.evaluate(() => [document.querySelector('[data-param="kind"]').value, document.body.dataset.kind]);

// Size and per-channel means of a PNG, decoded without color conversion.
const pngStats = (page, bytes) => page.evaluate(async (list) => {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(list)]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = c.getContext('2d');
  g.drawImage(bitmap, 0, 0);
  const data = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; }
  const n = data.length / 4;
  return { w: bitmap.width, h: bitmap.height, mean: sum.map((s) => s / n) };
}, [...bytes]);

test('the terrain kind swaps the controls and undo restores regular', async ({ page }) => {
  const errors = await start(page);
  expect(await kind(page)).toEqual(['regular', 'regular']);
  await expect(page.locator('#terrain')).toBeHidden();
  await page.evaluate(() => document.querySelector('#kind-seg [data-kind="terrain"]').click());
  expect(await kind(page)).toEqual(['terrain', 'terrain']);
  await page.evaluate(() => document.querySelector('[data-tab="maps"]')?.click());
  await expect(page.locator('#terrain')).toBeVisible();
  await expect(page.locator('[data-slot="metallic"]')).toBeHidden();
  await expect(page.locator('[data-slot="opacity"]')).toBeHidden();
  await expect(page.locator('#kind-seg [data-kind="terrain"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => document.getElementById('undo').click());
  await expect.poll(() => kind(page)).toEqual(['regular', 'regular']);
  await page.evaluate(() => document.getElementById('redo').click());
  await expect.poll(() => kind(page)).toEqual(['terrain', 'terrain']);
  expect(errors).toEqual([]);
});

test('terrain export holds detail and macro maps and a TerrainMaterial entry', async ({ page }) => {
  const errors = await start(page);
  await page.evaluate(() => document.querySelector('#kind-seg [data-kind="terrain"]').click());
  await page.waitForTimeout(600);
  const zip = await download(page, 'Control+e');
  const files = await unzipStore(new Uint8Array(await readFile(await zip.path())));
  const names = Object.keys(files).map((name) => name.split('/').pop()).sort();
  const json = Object.keys(files).find((name) => name.endsWith('main.materials.json'));
  const doc = JSON.parse(new TextDecoder().decode(files[json]));
  const [name] = Object.keys(doc);
  const expected = ['b', 'nm', 'r', 'ao', 'h'].flatMap((s) => ['t_' + name + '_' + s + '.png', 't_macro_' + name + '_' + s + '.png']);
  expect(names).toEqual([...expected, 'main.materials.json'].sort());
  expect(doc[name].class).toBe('TerrainMaterial');
  expect(doc[name].normalDetailTex.endsWith('/t_' + name + '_nm.png')).toBe(true);
  const file = (n) => files[Object.keys(files).find((k) => k.endsWith('/' + n) || k === n)];
  const detail = await pngStats(page, file('t_' + name + '_r.png'));
  const macro = await pngStats(page, file('t_macro_' + name + '_r.png'));
  expect(macro.w).toBe(detail.w / 2);
  for (const s of ['b', 'r', 'ao', 'h']) {
    const stats = await pngStats(page, file('t_' + name + '_' + s + '.png'));
    console.log('terrain detail', s, JSON.stringify(stats));
    for (const m of stats.mean) expect(Math.abs(m - 128), s + ' is recentred').toBeLessThan(12);
  }
  expect(errors).toEqual([]);
});

test('the terrain kind and its values survive a saved project', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    document.querySelector('#kind-seg [data-kind="terrain"]').click();
    const el = document.querySelector('[data-param="tNormalStr2"]');
    el.value = '0.33';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [saved] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const bytes = await readFile(await saved.path());
  const project = await readProject(bytes);
  expect(project.session.values['p:kind']).toBe('terrain');
  await gotoApp(page);
  await page.locator('#open-any').evaluate((input, list) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(list)], 'terrain.mwz', { type: 'application/x-material-wizard' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [...bytes]);
  await page.waitForFunction(() => document.body.dataset.kind === 'terrain');
  expect(await page.locator('[data-param="tNormalStr2"]').inputValue()).toBe('0.33');
});

const num = (page, param) => page.locator('[data-param="' + param + '"]').inputValue().then(Number);

async function setParam(page, param, value) {
  await page.locator('[data-param="' + param + '"]').evaluate((el, next) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const layer = (page, name) => page.locator('#layer-seg [data-layer="' + name + '"]').click();

// Left and right quarter means of the red channel, plus the width.
const halves = (page, bytes) => page.evaluate(async (list) => {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(list)]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = c.getContext('2d');
  g.drawImage(bitmap, 0, 0);
  const span = Math.floor(bitmap.width / 4);
  const mean = (x) => {
    const data = g.getImageData(x, 0, span, bitmap.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i];
    return sum / (data.length / 4);
  };
  return { left: mean(0), right: mean(bitmap.width - span), w: bitmap.width };
}, [...bytes]);

test('detail and macro keep their own photo and settings, and both survive a project', async ({ page }) => {
  test.setTimeout(90000);
  const errors = await start(page);
  await page.evaluate(() => document.querySelector('#kind-seg [data-kind="terrain"]').click());
  await page.waitForTimeout(800);
  await setParam(page, 'heightContrast', '2.2');
  await setParam(page, 'tCamHeight', '3');
  await layer(page, 'macro');
  expect(await num(page, 'heightContrast')).toBeCloseTo(2.2);
  expect(await num(page, 'tCamHeight')).toBeCloseTo(3);
  await expect(page.locator('[data-file-name="albedo"]')).toHaveText('Choose image');
  await setParam(page, 'heightContrast', '0.4');
  await page.evaluate(() => document.getElementById('undo').click());
  await expect.poll(() => num(page, 'heightContrast')).toBeCloseTo(2.2);
  await setParam(page, 'heightContrast', '0.4');
  await setParam(page, 'tCamHeight', '6');
  await layer(page, 'detail');
  expect(await num(page, 'heightContrast')).toBeCloseTo(2.2);
  expect(await num(page, 'tCamHeight')).toBeCloseTo(6);
  await layer(page, 'macro');
  expect(await num(page, 'heightContrast')).toBeCloseTo(0.4);
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#202020';
    g.fillRect(0, 0, 64, 128);
    g.fillStyle = '#e0e0e0';
    g.fillRect(64, 0, 64, 128);
    return [...new Uint8Array(await (await new Promise((r) => c.toBlob(r))).arrayBuffer())];
  });
  await page.locator('[data-slot-file="albedo"]').setInputFiles({ name: 'cloud.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('[data-file-name="albedo"]')).toHaveText('cloud.png');
  await page.waitForTimeout(800);
  const zip = await download(page, 'Control+e');
  const files = await unzipStore(new Uint8Array(await readFile(await zip.path())));
  const bases = Object.keys(files).filter((name) => /_b\.png$/.test(name));
  const macro = await halves(page, files[bases.find((name) => name.includes('t_macro_'))]);
  const detail = await halves(page, files[bases.find((name) => !name.includes('t_macro_'))]);
  expect(macro.right - macro.left).toBeGreaterThan(40);
  expect(Math.abs(detail.right - detail.left)).toBeLessThan(25);
  expect(detail.w).toBe(256);
  expect(macro.w).toBe(128);
  await layer(page, 'detail');
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [saved] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const project = await readProject(await readFile(await saved.path()));
  expect(project.session.layers.active).toBe('detail');
  expect(project.session.layers.macro.photo).toBeTruthy();
  expect(Number(project.session.values['p:heightContrast'])).toBeCloseTo(2.2);
  expect(Number(project.session.layers.macro.values['p:heightContrast'])).toBeCloseTo(0.4);
  expect(project.session.layers.macro.values['p:tCamHeight']).toBeUndefined();
  await gotoApp(page);
  await page.locator('#open-any').evaluate((input, list) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(list)], 'terrain.mwz', { type: 'application/x-material-wizard' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [...await readFile(await saved.path())]);
  await page.waitForFunction(() => document.body.dataset.kind === 'terrain');
  expect(await num(page, 'heightContrast')).toBeCloseTo(2.2);
  expect(await num(page, 'tCamHeight')).toBeCloseTo(6);
  await layer(page, 'macro');
  expect(await num(page, 'heightContrast')).toBeCloseTo(0.4);
  await expect(page.locator('[data-file-name="albedo"]')).toHaveText('cloud.png');
  expect(errors).toEqual([]);
});
