import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { unzipStore } from '../src/export.js';
import { download, gotoApp, keepDrawingBuffer, openCanvas, painted, setView, settled } from './helpers.js';

// Set UPDATE_GOLDEN=1 to rewrite test/golden after an intended change in output.
const GOLDEN = new URL('./golden/', import.meta.url);
const UPDATE = !!process.env.UPDATE_GOLDEN;

function drawSample(c) {
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const image = g.createImageData(256, 256);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      const n = rand() * 40;
      const stone = Math.sin(x * 0.11) * Math.cos(y * 0.07) > 0.3 ? 50 : 0;
      image.data[i] = 120 + n + stone + x * 0.1;
      image.data[i + 1] = 95 + n + stone * 0.8;
      image.data[i + 2] = 70 + n * 0.8 + stone * 0.6 + y * 0.08;
      image.data[i + 3] = 255;
    }
  }
  g.putImageData(image, 0, 0);
}

async function compare(page, name, bytes) {
  const file = new URL(name, GOLDEN);
  if (UPDATE || !existsSync(file)) {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(file, bytes);
    return null;
  }
  const golden = await readFile(file);
  return page.evaluate(async ({ a, b }) => {
    const decode = async (list) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(list)]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = c.getContext('2d');
      g.drawImage(bitmap, 0, 0);
      return g.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const x = await decode(a);
    const y = await decode(b);
    if (x.width !== y.width || x.height !== y.height) return { size: [x.width, x.height, y.width, y.height] };
    let sum = 0;
    let max = 0;
    let bad = 0;
    for (let i = 0; i < x.data.length; i++) {
      const d = Math.abs(x.data[i] - y.data[i]);
      sum += d;
      if (d > max) max = d;
      if (d > 8) bad++;
    }
    return { mean: sum / x.data.length, max, bad: bad / x.data.length };
  }, { a: [...bytes], b: [...golden] });
}

function expectClose(name, result, limits = { mean: 1, bad: 0.005 }) {
  if (!result) return;
  console.log('golden', name, JSON.stringify(result));
  expect.soft(result.size, name + ' size').toBeUndefined();
  expect.soft(result.mean, name + ' mean difference').toBeLessThan(limits.mean);
  expect.soft(result.bad, name + ' pixels off by more than 8').toBeLessThan(limits.bad);
}

test('maps and the lit view match the golden images', async ({ page }) => {
  await keepDrawingBuffer(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await openCanvas(page, drawSample, 'golden.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await setView(page, 'preview');
  await page.waitForTimeout(500);
  await settled(page);
  const lit = await page.locator('#view').evaluate((c) => c.toDataURL('image/png'));
  const litBytes = Buffer.from(lit.split(',')[1], 'base64');
  expectClose('lit view', await compare(page, 'lit.png', litBytes), { mean: 2, bad: 0.02 });
  const zip = await download(page, 'Control+e');
  const files = await unzipStore(new Uint8Array(await readFile(await zip.path())));
  const pngs = Object.keys(files).filter((name) => name.endsWith('.png')).sort();
  expect(pngs.length).toBeGreaterThanOrEqual(5);
  for (const name of pngs) {
    expectClose(name, await compare(page, name.split('/').pop(), Buffer.from(files[name])));
  }
  const [height] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => document.querySelector('[data-save="height"]').click()),
  ]);
  expectClose('height', await compare(page, 'golden_h.dataR.png', await readFile(await height.path())));
});

test('the terrain preview matches the golden images near and far', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message || String(error)));
  await keepDrawingBuffer(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await openCanvas(page, drawSample, 'golden.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#kind-seg [data-kind="terrain"]').click());
  await setView(page, 'preview');
  for (const height of [2, 60]) {
    await page.evaluate((value) => {
      const el = document.querySelector('[data-param="tCamHeight"]');
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(height));
    await page.waitForTimeout(800);
    await settled(page);
    const shot = await page.locator('#view').evaluate((c) => c.toDataURL('image/png'));
    const name = 'terrain_' + height + 'm.png';
    expectClose(name, await compare(page, name, Buffer.from(shot.split(',')[1], 'base64')), { mean: 2, bad: 0.02 });
  }
  expect(errors).toEqual([]);
});
