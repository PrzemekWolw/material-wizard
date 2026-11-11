import { expect, test } from '@playwright/test';
import { gotoApp, keepDrawingBuffer, openCanvas, painted, setView, settled } from './helpers.js';

function drawNoise(c) {
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const image = g.createImageData(128, 128);
  let seed = 5;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = (seed / 0x7fffffff) * 80;
    image.data[i] = 90 + n;
    image.data[i + 1] = 80 + n;
    image.data[i + 2] = 70 + n;
    image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
}

const runs = (page) => page.evaluate(async () => (await import('./src/modules/render.js')).engine.stageRuns());

async function slide(page, param, value) {
  const before = await runs(page);
  await page.evaluate(({ param, value }) => {
    const el = document.querySelector('[data-param="' + param + '"]');
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { param, value });
  await page.waitForFunction(async (count) => {
    const now = (await import('./src/modules/render.js')).engine.stageRuns();
    return Object.values(now).reduce((a, b) => a + b, 0) > count;
  }, Object.values(before).reduce((a, b) => a + b, 0));
  await page.waitForTimeout(300);
  const after = await runs(page);
  return Object.keys(after).filter((name) => after[name] !== before[name]).sort();
}

test('a slider reruns only the stages that read it', async ({ page }) => {
  await keepDrawingBuffer(page);
  await gotoApp(page);
  await openCanvas(page, drawNoise, 'noise.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  expect(await slide(page, 'roughContrast', '1.6')).toEqual(['remap:rough', 'rough']);
  expect(await slide(page, 'metalWear', '0.4')).toEqual(['metal', 'remap:metal']);
  expect(await slide(page, 'aoDepth', '1.5')).toEqual(['ao', 'remap:ao', 'remap:rough', 'rough']);
  expect(await slide(page, 'adjRoughnessGamma', '2')).toEqual(['remap:rough']);
});

const engineCall = (page, body) => page.evaluate(async (code) => {
  const { engine } = await import('./src/modules/render.js');
  return new Function('engine', code)(engine);
}, body);

test('view changes only present, and the lit view stops accumulating', async ({ page }) => {
  await keepDrawingBuffer(page);
  await gotoApp(page);
  await openCanvas(page, drawNoise, 'noise.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await setView(page, 'preview');
  await page.waitForTimeout(500);
  await settled(page);
  const before = await runs(page);
  await page.evaluate(() => {
    for (const [param, value] of [['shape', 'sphere'], ['layout', '2x2'], ['split', '0.4']]) {
      const el = document.querySelector('[data-param="' + param + '"]');
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.waitForTimeout(600);
  expect(await runs(page)).toEqual(before);
  await settled(page);
});

function drawLarge(c) {
  c.width = c.height = 1536;
  const g = c.getContext('2d');
  for (let y = 0; y < 1536; y += 32) {
    for (let x = 0; x < 1536; x += 32) {
      g.fillStyle = 'rgb(' + (90 + ((x * 7 + y * 13) % 90)) + ',80,70)';
      g.fillRect(x, y, 32, 32);
    }
  }
}

test('dragging a slow slider renders a draft, then full size', async ({ page }) => {
  await keepDrawingBuffer(page);
  await gotoApp(page);
  await openCanvas(page, drawLarge, 'large.png');
  await page.waitForFunction(painted, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  expect(await engineCall(page, 'return engine.size().w;')).toBe(1536);
  await page.evaluate(() => {
    const el = document.querySelector('[data-param="relief"]');
    el.value = '0.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(async () => (await import('./src/modules/render.js')).engine.size().w === 1024, null, { timeout: 30000 });
  await page.waitForFunction(async () => (await import('./src/modules/render.js')).engine.size().w === 1536, null, { timeout: 60000 });
});

test('thumbnails draw without preserveDrawingBuffer', async ({ page }) => {
  await gotoApp(page);
  await openCanvas(page, drawNoise, 'noise.png');
  await page.waitForFunction(() => {
    const c = document.querySelector('.mw-thumb canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lo = 255; let hi = 0;
    for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
    return hi - lo > 20;
  }, null, { timeout: 30000 });
});
