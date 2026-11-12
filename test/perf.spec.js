import { expect, test } from '@playwright/test';
import { countTextureBytes, download, gotoApp, keepDrawingBuffer, openCanvas, painted, setView } from './helpers.js';

// Prints timings and memory for a 1024 photo. Compare against test/baseline.md by hand.
function drawPhoto(c) {
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const image = g.createImageData(1024, 1024);
  let seed = 3;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = (seed / 0x7fffffff) * 60;
    const p = i / 4;
    const x = p % 1024;
    const y = (p / 1024) | 0;
    const stone = Math.sin(x * 0.03) * Math.cos(y * 0.025) > 0.2 ? 60 : 0;
    image.data[i] = 100 + n + stone;
    image.data[i + 1] = 85 + n + stone * 0.8;
    image.data[i + 2] = 70 + n + stone * 0.6;
    image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
}

async function timeChange(page, change) {
  return page.evaluate(async (body) => {
    const canvas = document.querySelector('#view');
    const gl = canvas.getContext('webgl2');
    const sample = () => {
      const px = new Uint8Array(4);
      gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px.join(',');
    };
    const before = sample();
    const start = performance.now();
    new Function(body)();
    while (sample() === before && performance.now() - start < 10000) await new Promise(requestAnimationFrame);
    return Math.round(performance.now() - start);
  }, change);
}

// A 1024 photo through software GL takes a while on the CI runner.
test.slow();

test('performance and memory numbers', async ({ page }) => {
  await keepDrawingBuffer(page);
  await countTextureBytes(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  const start = Date.now();
  await openCanvas(page, drawPhoto, 'perf.png');
  await page.waitForFunction(painted, null, { timeout: 30000 });
  const out = { firstPaint: Date.now() - start };
  await page.waitForTimeout(500);
  out.slider = await timeChange(page, `
    const el = document.querySelector('[data-param="relief"]');
    el.value = '0.9';
    el.dispatchEvent(new Event('input', { bubbles: true }));`);
  await page.waitForTimeout(300);
  out.viewSwitch = await timeChange(page, `
    const select = document.getElementById('view-mode');
    select.value = 'preview';
    select.dispatchEvent(new Event('change', { bubbles: true }));`);
  await page.waitForTimeout(1500);
  out.sun = await timeChange(page, `
    const dial = document.getElementById('sun-dial');
    const r = dial.getBoundingClientRect();
    const at = { bubbles: true, clientX: r.left + r.width * 0.8, clientY: r.top + r.height * 0.3, pointerId: 3, pointerType: 'mouse', buttons: 1 };
    dial.setPointerCapture = () => {};
    dial.dispatchEvent(new PointerEvent('pointerdown', at));
    dial.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));`);
  await setView(page, 'albedo');
  await page.waitForTimeout(500);
  let t = Date.now();
  await download(page, 'Control+e');
  out.export = Date.now() - t;
  t = Date.now();
  await download(page, 'Control+s');
  out.save = Date.now() - t;
  const memory = await page.evaluate(() => ({
    textureMB: Math.round(window.textureBytes() / 1048576),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  }));
  Object.assign(out, memory);
  console.log('perf ' + JSON.stringify(out));
  expect(out.textureMB, 'texture memory below the Phase 0 baseline').toBeLessThan(161);
});
