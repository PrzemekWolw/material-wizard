import { expect, test } from '@playwright/test';
import { gotoApp, keepDrawingBuffer, openCanvas, painted, setView, settled } from './helpers.js';

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

async function setParam(page, param, value) {
  await page.evaluate(({ param, value }) => {
    const el = document.querySelector('[data-param="' + param + '"]');
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { param, value });
}

const grayRange = (page, name) => page.evaluate(async (map) => {
  const { engine } = await import('./src/modules/render.js');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const { rgba } = engine.readMap(map);
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < rgba.length; i += 4) { lo = Math.min(lo, rgba[i]); hi = Math.max(hi, rgba[i]); }
  return [lo, hi];
}, name);

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

test('levels and the curve change only their map, and undo restores them', async ({ page }) => {
  const errors = await start(page);
  const before = await grayRange(page, 'rough');
  await setParam(page, 'adjRoughnessOutMax', '0.2');
  const after = await grayRange(page, 'rough');
  expect(after[1]).toBeLessThanOrEqual(52);
  expect(after[1]).toBeLessThan(before[1]);
  await setParam(page, 'adjRoughnessOutMax', '1');
  expect(await grayRange(page, 'rough')).toEqual(before);

  await page.evaluate(() => { document.querySelector('[data-slot-adjust="ao"]').open = true; });
  const curve = page.locator('[data-curve="ao"]');
  await curve.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await page.locator('[data-param="adjAoCurve"]').inputValue()).toBe('0,0.25,0.4,0.75,1');
  await expect(page.locator('[data-curve-reset="ao"]')).toBeVisible();
  expect(await curve.getAttribute('aria-valuenow')).toBe('0.40');
  await page.evaluate(() => document.getElementById('undo').click());
  await expect(page.locator('[data-param="adjAoCurve"]')).toHaveValue('0,0.25,0.5,0.75,1');
  await expect(page.locator('[data-curve-reset="ao"]')).toBeHidden();
  expect(errors).toEqual([]);
});

test('local contrast roughness, bombing and the repetition view', async ({ page }) => {
  const errors = await start(page);
  const flat = await grayRange(page, 'rough');
  await setParam(page, 'localRough', '1');
  const local = await grayRange(page, 'rough');
  expect(local).not.toEqual(flat);

  await page.evaluate(() => document.querySelector('[data-tab="tile"]').click());
  await setParam(page, 'tileOn', true);
  await page.waitForFunction(() => document.querySelectorAll('.mw-seam [data-seam]').length === 2, null, { timeout: 15000 });
  const albedo = (previous) => page.waitForFunction(async (prev) => {
    const map = (await import('./src/modules/render.js')).engine.readMap('albedo');
    let h = 0;
    for (let i = 0; i < map.rgba.length; i++) h = (h * 31 + map.rgba[i]) | 0;
    return h !== prev && h;
  }, previous, { timeout: 15000, polling: 300 }).then((handle) => handle.jsonValue());
  const plain = await albedo(null);
  await setParam(page, 'bombAmount', '0.5');
  const bombed = await albedo(plain);
  await setParam(page, 'bombSeed', '2');
  await albedo(bombed);

  await page.evaluate(() => document.querySelector('[data-tile-view="repeat"]').click());
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.querySelector('[data-tile-view="repeat"]').classList.contains('is-active'))).toBe(true);
  expect(errors).toEqual([]);
});

test('name pattern, copy materials.json and the preset round trip', async ({ page }) => {
  const errors = await start(page);
  await page.evaluate(() => {
    window.copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => { window.copied = value; } } });
  });
  await setParam(page, 'name', 'stone');
  await setParam(page, 'prefix', 'lv_');
  await setParam(page, 'namePattern', '{prefix}{name}_{n:02}');
  await expect(page.locator('#name-preview')).toContainText('lv_stone_01');
  await page.evaluate(() => document.getElementById('copy-json').click());
  await page.waitForFunction(() => window.copied);
  const json = JSON.parse(await page.evaluate(() => window.copied));
  expect(Object.keys(json)).toEqual(['lv_stone_01']);
  expect(json.lv_stone_01.mapTo).toBe('lv_stone_01');
  await expect(page.locator('#copy-note')).not.toBeEmpty();

  await setParam(page, 'localRough', '0.4');
  await setParam(page, 'bombAmount', '0.3');
  await setParam(page, 'adjAlbedoGamma', '1.5');
  await page.evaluate(() => {
    const input = document.querySelector('[data-param="adjHeightCurve"]');
    input.value = '0,0.3,0.5,0.7,1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('preset-name').value = 'phase6';
    document.getElementById('preset-save').click();
  });
  for (const [param, value] of [['localRough', '0'], ['bombAmount', '0'], ['adjAlbedoGamma', '1'], ['prefix', ''], ['namePattern', '{prefix}{name}']]) await setParam(page, param, value);
  await page.evaluate(() => {
    const input = document.querySelector('[data-param="adjHeightCurve"]');
    input.value = '0,0.25,0.5,0.75,1';
    const list = document.getElementById('preset-list');
    list.value = 'phase6';
    list.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const values = await page.evaluate(() => Object.fromEntries(['localRough', 'bombAmount', 'adjAlbedoGamma', 'adjHeightCurve', 'prefix', 'namePattern']
    .map((key) => [key, document.querySelector('[data-param="' + key + '"]').value])));
  expect(values).toEqual({ localRough: '0.4', bombAmount: '0.3', adjAlbedoGamma: '1.5', adjHeightCurve: '0,0.3,0.5,0.7,1', prefix: 'lv_', namePattern: '{prefix}{name}_{n:02}' });
  expect(errors).toEqual([]);
});

test('opacity shows the background or the checker in the lit view', async ({ page }) => {
  const errors = await start(page);
  await page.evaluate(() => {
    const mode = document.querySelector('[data-slot-mode="opacity"]');
    mode.value = 'flat';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const flat = document.querySelector('[data-slot-flat="opacity"]');
    flat.value = '0';
    flat.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await setView(page, 'preview');
  await settled(page);
  const shot = () => page.evaluate(() => document.getElementById('view').toDataURL());
  const checker = await shot();
  await setParam(page, 'alphaView', 'background');
  await settled(page);
  expect(await shot()).not.toBe(checker);
  expect(errors).toEqual([]);
});
