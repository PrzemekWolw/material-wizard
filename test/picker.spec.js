import { expect, test } from '@playwright/test';
import { gotoApp, keepDrawingBuffer, trackErrors } from './helpers.js';

test.beforeEach(({ page }) => keepDrawingBuffer(page));
trackErrors(test);

for (const layout of ['1x1', '2x2']) {
  test('the picker reads the pixel under the cursor when zoomed, layout ' + layout, async ({ page }) => {
    await gotoApp(page);
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
  await gotoApp(page);
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
  await gotoApp(page);
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
