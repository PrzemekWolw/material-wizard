import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readProject } from '../src/export.js';
import { VERSION } from '../version.js';
import { gotoApp, keepDrawingBuffer, trackErrors } from './helpers.js';

test.beforeEach(({ page }) => keepDrawingBuffer(page));
trackErrors(test);

async function openPng(page) {
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = '#c45a32';
    g.fillRect(0, 0, 48, 48);
    g.fillStyle = '#f0d0a0';
    g.beginPath();
    g.arc(24, 24, 10, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL('image/png');
  });
  await page.locator('#open-file').evaluate((input, data) => {
    const bin = atob(data.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'sample.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, png);
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
}

test('settings, version, corrupt open and failed save', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await gotoApp(page);
  expect(await page.locator('#app-version').textContent()).toBe('Material Wizard ' + VERSION);
  expect(await page.locator('[data-zone-row="0"] h3').textContent()).toBe('Base material');
  expect(await page.locator('#zones > h3').textContent()).toBe('Zones');
  expect(await page.locator('[data-param="albedoFix"]').isChecked()).toBe(false);
  expect(await page.locator('[data-param="tileEven"]').isChecked()).toBe(true);
  expect(await page.locator('[data-load-detail="ao"]').isHidden()).toBe(true);
  expect(await page.locator('[data-load-detail="roughness"]').isHidden()).toBe(true);
  expect(await page.locator('[data-load-detail="metallic"]').isHidden()).toBe(true);
  const reset = await page.evaluate(() => {
    const el = document.querySelector('[data-param="delight"]');
    el.value = '0.1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const button = el.parentElement.querySelector('.mw-reset');
    const shown = button && !button.hidden;
    button.click();
    return { shown, value: el.value };
  });
  expect(reset.shown).toBe(true);
  expect(reset.value).toBe('0.65');
  await openPng(page);
  await page.waitForFunction(() => {
    const c = document.querySelector('#view');
    const gl = c && c.getContext('webgl2');
    if (!gl) return false;
    const px = new Uint8Array(4);
    gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[0] + px[1] + px[2] > 8;
  });
  const lighting = await page.evaluate(async () => {
    const canvas = document.querySelector('#view');
    canvas.setPointerCapture = () => {};
    const view = document.getElementById('view-mode');
    view.value = 'albedo';
    view.dispatchEvent(new Event('change', { bubbles: true }));
    const sample = () => {
      const gl = canvas.getContext('webgl2');
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const sum = px[0] + px[1] + px[2] || 1;
      return [px[0] / sum, px[1] / sum, px[0] + px[1] + px[2]];
    };
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = sample();
    const relief = document.querySelector('[data-param="relief"]');
    relief.value = '1';
    relief.dispatchEvent(new Event('input', { bubbles: true }));
    let after = sample();
    for (let i = 0; i < 40 && after[2] === before[2]; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = sample();
    }
    document.getElementById('pick-white').click();
    const rect = canvas.getBoundingClientRect();
    const at = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, pointerType: 'mouse' };
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...at, buttons: 0 }));
    const picking = document.querySelector('#drop').classList.contains('mw-picking');
    const loupe = !document.getElementById('loupe').hidden;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
    document.getElementById('auto-white').click();
    return {
      delta: Math.hypot(before[0] - after[0], before[1] - after[1]),
      changed: before[2] !== after[2],
      picking,
      loupe,
      done: !document.querySelector('#drop').classList.contains('mw-picking'),
    };
  });
  expect(lighting.changed).toBe(true);
  expect(lighting.delta).toBeLessThan(0.08);
  expect(lighting.picking).toBe(true);
  expect(lighting.loupe).toBe(true);
  expect(lighting.done).toBe(true);
  await page.evaluate(() => {
    document.querySelector('[data-slot-file="ao"]').click = () => {};
    document.querySelector('[data-slot="ao"] [data-mode="load"]').click();
  });
  expect(await page.locator('[data-load-detail="ao"]').evaluate((el) => el.hidden)).toBe(false);
  await page.evaluate(async () => { window.beforeOriginal = (await import('./src/services/state.js')).state.original; });
  await page.locator('#open-any').evaluate((input) => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'broken.mwz', { type: 'application/x-material-wizard' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#warnings').textContent.includes('could not be read'));
  expect(await page.evaluate(async () => (await import('./src/services/state.js')).state.original === window.beforeOriginal && !!window.beforeOriginal)).toBe(true);
  await page.evaluate(() => {
    delete window.showSaveFilePicker;
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob) => { window.savedType = blob.type; return create(blob); };
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  expect(await page.evaluate(() => window.savedType)).toBe('application/x-material-wizard');
  const project = await readProject(await readFile(await download.path()));
  expect(project.session.version).toBe(VERSION);
  expect(download.suggestedFilename()).toMatch(/\.mwz$/);
  expect(project.session.photo).toBe('photo.png');
  await page.evaluate(() => {
    window.createImageBitmap = () => Promise.reject(new Error('boom'));
  });
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('#warnings').textContent.includes('could not be verified'));
  expect(downloaded).toBe(false);
  expect(errors).toEqual([]);
});

async function openFlat(page, color) {
  const png = await page.evaluate((fill) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = fill;
    g.fillRect(0, 0, 64, 64);
    return c.toDataURL('image/png');
  }, color);
  await page.locator('#open-file').evaluate((input, data) => {
    const bin = atob(data.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'flat.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, png);
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
}

test('chrome text cannot be selected, fields can', async ({ page }) => {
  await gotoApp(page);
  const selectable = (selector) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).userSelect);
  expect(await selectable('.mw-tabs button')).toBe('none');
  expect(await selectable('#app-version')).toBe('text');
  expect(await selectable('#preset-name')).toBe('text');
});

test('File New resets to the starting point and can be undone', async ({ page }) => {
  await gotoApp(page);
  await openFlat(page, '#808080');
  await page.evaluate(() => {
    const el = document.querySelector('[data-param="delight"]');
    el.value = '1.2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('[data-file-action="new"]').click());
  expect(await page.evaluate(() => document.querySelector('#drop').classList.contains('has-image'))).toBe(false);
  expect(await page.locator('[data-param="delight"]').inputValue()).toBe('0.65');
  await page.evaluate(() => document.getElementById('undo').click());
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  expect(await page.locator('[data-param="delight"]').inputValue()).toBe('1.2');
});
