import { expect, test } from '@playwright/test';
import { gotoApp, keepDrawingBuffer, trackErrors } from './helpers.js';

test.beforeEach(({ page }) => keepDrawingBuffer(page));
trackErrors(test);

test('crop cuts the photo to the chosen shape', async ({ page }) => {
  await gotoApp(page);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 80;
    c.height = 40;
    const g = c.getContext('2d');
    g.fillStyle = '#c04020';
    g.fillRect(0, 0, 80, 40);
    g.fillStyle = '#2040c0';
    g.fillRect(0, 0, 4, 4);
    return c.toDataURL('image/png');
  });
  await page.locator('#open-file').evaluate((input, data) => {
    const bin = atob(data.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'wide.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, png);
  await page.waitForFunction(() => document.querySelector('#drop').classList.contains('has-image'));
  await page.evaluate(() => {
    document.querySelector('[data-tab="fix"]').click();
    document.querySelector('[data-fix-mode="crop"]').click();
    const shape = document.getElementById('adjust-shape');
    shape.value = '1:1';
    shape.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('apply-crop').click();
    const view = document.getElementById('view-mode');
    view.value = 'source';
    view.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  const pixel = await page.evaluate(() => {
    const canvas = document.querySelector('#view');
    const gl = canvas.getContext('webgl2');
    const px = new Uint8Array(4);
    gl.readPixels(2, canvas.height - 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[2]];
  });
  expect(pixel[0]).toBeGreaterThan(150);
  expect(pixel[1]).toBeLessThan(80);
});
