import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readProject } from '../export.js';

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
  await page.goto('/index.html');
  expect(await page.locator('#app-version').textContent()).toBe('Material Wizard 0.2.0');
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = sample();
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
  const before = await page.locator('#view').evaluate((c) => c.toDataURL());
  await page.locator('#open-any').evaluate((input) => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'broken.mwz', { type: 'application/zip' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('#warnings').textContent.includes('could not be read'));
  expect(await page.locator('#view').evaluate((c) => c.toDataURL())).toBe(before);
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  const project = await readProject(await readFile(await download.path()));
  expect(project.session.version).toBe('0.2.0');
  expect(project.session.photo).toBe('photo.png');
  await page.evaluate(() => {
    window.CompressionStream = class extends CompressionStream {
      constructor(format) {
        if (format === 'deflate-raw') throw new Error('boom');
        super(format);
      }
    };
  });
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('#warnings').textContent.includes('could not be verified'));
  expect(downloaded).toBe(false);
  expect(errors).toEqual([]);
});

test('a jpeg project keeps the original photo bytes', async ({ page }) => {
  await page.goto('/index.html');
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
  expect(saved.length).toBeLessThan(files.png);
});

for (const layout of ['1x1', '2x2']) {
  test('the picker reads the pixel under the cursor when zoomed, layout ' + layout, async ({ page }) => {
    await page.goto('/index.html');
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const image = g.createImageData(128, 128);
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const i = (y * 128 + x) * 4;
          image.data[i] = x * 2;
          image.data[i + 1] = y * 2;
          image.data[i + 2] = 60;
          image.data[i + 3] = 255;
        }
      }
      g.putImageData(image, 0, 0);
      return c.toDataURL('image/png');
    });
    await page.locator('#open-file').evaluate((input, data) => {
      const bin = atob(data.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'ramp.png', { type: 'image/png' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, png);
    await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
    await page.waitForTimeout(600);
    const result = await page.evaluate(async ({ layout }) => {
      const canvas = document.querySelector('#view');
      canvas.setPointerCapture = () => {};
      const layoutSelect = document.querySelector('[data-param="layout"]');
      layoutSelect.value = layout;
      layoutSelect.dispatchEvent(new Event('input', { bubbles: true }));
      const view = document.getElementById('view-mode');
      view.value = 'source';
      view.dispatchEvent(new Event('change', { bubbles: true }));
      const zoom = document.getElementById('zoom');
      zoom.value = '3';
      zoom.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      document.getElementById('pick-white').click();
      const rect = canvas.getBoundingClientRect();
      const out = [];
      for (const [fx, fy] of [[0.56, 0.44], [0.8, 0.3], [0.25, 0.7]]) {
        const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
        const w = canvas.width * scale;
        const h = canvas.height * scale;
        const clientX = rect.left + (rect.width - w) / 2 + w * fx;
        const clientY = rect.top + (rect.height - h) / 2 + h * fy;
        const at = { bubbles: true, clientX, clientY, pointerId: 1, pointerType: 'mouse' };
        canvas.dispatchEvent(new PointerEvent('pointermove', { ...at, buttons: 0 }));
        const gl = canvas.getContext('webgl2');
        const px = new Uint8Array(4);
        gl.readPixels(Math.floor(canvas.width * fx), Math.floor(canvas.height * (1 - fy)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const hex = document.querySelector('#loupe span').textContent;
        out.push({ shown: [px[0], px[1], px[2]], picked: [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) });
      }
      return out;
    }, { layout });
    for (const row of result) {
      expect(Math.abs(row.shown[0] - row.picked[0])).toBeLessThan(12);
      expect(Math.abs(row.shown[1] - row.picked[1])).toBeLessThan(12);
    }
  });
}

test('cast shadows lifts a dark area while lighting correction stays off', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/index.html');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(40, 30, 20)';
    g.fillRect(0, 0, 32, 64);
    g.fillStyle = 'rgb(180, 140, 100)';
    g.fillRect(32, 0, 32, 64);
    return c.toDataURL('image/png');
  });
  await page.locator('#open-file').evaluate((input, data) => {
    const bin = atob(data.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'half.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, png);
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  const sample = () => page.evaluate(async () => {
    const view = document.getElementById('view-mode');
    view.value = 'albedo';
    view.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const canvas = document.querySelector('#view');
    const gl = canvas.getContext('webgl2');
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.5), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[0] + px[1] + px[2];
  });
  const before = await sample();
  await page.evaluate(() => {
    const el = document.querySelector('[data-param="shadowFix"]');
    el.value = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const after = await sample();
  expect(await page.locator('[data-param="albedoFix"]').isChecked()).toBe(false);
  expect(after).toBeGreaterThan(before + 15);
  expect(errors).toEqual([]);
});

test('picked lighting colors add, remove and clear', async ({ page }) => {
  await page.goto('/index.html');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#a08060';
    g.fillRect(0, 0, 64, 64);
    return c.toDataURL('image/png');
  });
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
  await page.waitForTimeout(600);
  const pick = () => page.evaluate(() => {
    document.getElementById('pick-light').click();
    const canvas = document.querySelector('#view');
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const at = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, pointerId: 1, pointerType: 'mouse' };
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...at, buttons: 0 }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
  });
  const shown = (id) => page.locator(id).evaluate((el) => !el.classList.contains('mw-hidden'));
  expect(await shown('#light-options')).toBe(false);
  await page.evaluate(() => document.querySelector('[data-view="albedo"]').click());
  await pick();
  expect(await page.locator('#view-mode').inputValue()).toBe('albedo');
  await pick();
  expect(await page.locator('.mw-swatch').count()).toBe(2);
  expect(await shown('#light-options')).toBe(true);
  await page.locator('.mw-swatch').first().evaluate((el) => el.click());
  expect(await page.locator('.mw-swatch').count()).toBe(1);
  await page.evaluate(() => document.getElementById('clear-light').click());
  expect(await page.locator('.mw-swatch').count()).toBe(0);
  expect(await shown('#light-options')).toBe(false);
  expect(await page.locator('[data-param="albedoFix"]').isChecked()).toBe(false);
});
