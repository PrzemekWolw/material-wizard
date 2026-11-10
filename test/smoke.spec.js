import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('load, render, save and reopen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (msg.text().includes('Failed to load resource')) return;
    errors.push(msg.text());
  });
  await page.goto('/index.html');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#886655';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#334455';
    g.fillRect(8, 8, 20, 20);
    return c.toDataURL('image/png');
  });
  await page.locator('#open-file').evaluate((input, data) => {
    const bin = atob(data.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'gravel.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, png);
  const painted = () => {
    const c = document.querySelector('#view');
    const gl = c && c.getContext('webgl2');
    if (!gl || c.width < 2) return false;
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[0] + px[1] + px[2] > 8;
  };
  await page.waitForFunction(painted, null, { timeout: 15000 });
  expect(errors, errors.join('\n')).toEqual([]);
  const before = await page.locator('#view').evaluate((c) => c.toDataURL());
  const name = await page.locator('[data-param="name"]').inputValue();
  await page.evaluate(() => { delete window.showSaveFilePicker; });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  const saved = await readFile(await download.path());
  await page.locator('#open-any').evaluate((input, list) => {
    const file = new File([Uint8Array.from(list)], 'gravel.mwz', { type: 'application/zip' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [...saved]);
  await page.waitForFunction(painted, null, { timeout: 15000 });
  expect(await page.locator('[data-param="name"]').inputValue()).toBe(name);
  expect(await page.locator('#view').evaluate((c) => c.toDataURL())).toBe(before);
  expect(errors, errors.join('\n')).toEqual([]);
});
