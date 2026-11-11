import { expect, test } from '@playwright/test';
import { gotoApp, keepDrawingBuffer, openCanvas, painted } from './helpers.js';

function drawStones(c) {
  c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let y = 0; y < 128; y += 16) {
    for (let x = 0; x < 128; x += 16) {
      g.fillStyle = (x + y) % 32 ? '#884422' : '#ccaa66';
      g.fillRect(x, y, 16, 16);
    }
  }
}

const active = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el.id || el.dataset.kind || el.tagName;
});

test('the tooltip shows on keyboard focus without a native title and hides on Escape', async ({ page }) => {
  await gotoApp(page);
  expect(await page.locator('[title]').count()).toBe(0);
  await page.locator('#tab-maps').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  expect(await active(page)).toBe('regular');
  const tip = page.locator('#mw-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText(/./);
  await expect(page.locator('#kind-seg')).toHaveAttribute('aria-describedby', 'mw-tip');
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await expect(page.locator('#kind-seg')).not.toHaveAttribute('aria-describedby', 'mw-tip');
});

test('tabs use tab roles, arrow keys and a roving tabindex', async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator('#tabs')).toHaveAttribute('role', 'tablist');
  await page.locator('#tab-maps').focus();
  await page.keyboard.press('ArrowRight');
  expect(await active(page)).toBe('tab-fix');
  await expect(page.locator('#tab-fix')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-maps')).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('#panel-fix')).toBeVisible();
  await page.keyboard.press('End');
  expect(await active(page)).toBe('tab-export');
  await page.keyboard.press('Home');
  expect(await active(page)).toBe('tab-maps');
  const resets = await page.evaluate(() => [...document.querySelectorAll('.mw-reset')].slice(0, 3).map((b) => b.getAttribute('aria-label')));
  for (const label of resets) expect(label).toMatch(/^Reset \S/);
});

test('keyboard picking moves the loupe, picks with Enter and returns focus', async ({ page }) => {
  await keepDrawingBuffer(page);
  await gotoApp(page);
  await openCanvas(page, drawStones, 'stones.png');
  await page.waitForFunction(painted, null, { timeout: 15000 });
  await page.evaluate(() => document.getElementById('tab-albedo').click());
  await page.locator('#pick-white').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#drop')).toHaveClass(/mw-picking/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('#loupe')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#drop')).not.toHaveClass(/mw-picking/);
  expect(await active(page)).toBe('pick-white');
  const balance = await page.evaluate(async () => (await import('./src/services/state.js')).state.whiteBalance);
  expect(balance).not.toBeNull();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('#drop')).not.toHaveClass(/mw-picking/);
  expect(await active(page)).toBe('pick-white');
});

test('reduced motion snaps a short swipe back without animating', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 400, height: 820 });
  await gotoApp(page);
  const state = await page.evaluate(() => {
    const aside = document.querySelector('.mw-page > aside');
    const panel = aside.querySelector('[data-panel]:not(.mw-hidden)');
    const rect = panel.getBoundingClientRect();
    const x = rect.left + rect.width * 0.7;
    const y = rect.top + 40;
    const fire = (type, dx) => panel.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch', clientX: x + dx, clientY: y }));
    fire('pointerdown', 0);
    fire('pointermove', -20);
    fire('pointermove', -40);
    fire('pointerup', -40);
    return { animating: panel.classList.contains('mw-swipe-back'), transform: panel.style.transform };
  });
  expect(state).toEqual({ animating: false, transform: '' });
});

test('a pointercancel mid-drag leaves no stuck state', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  const r = await page.locator('#split').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + 40);
  await page.mouse.down();
  const during = await page.evaluate(() => document.body.classList.contains('mw-resizing'));
  const after = await page.evaluate(() => {
    const split = document.getElementById('split');
    split.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'mouse' }));
    return document.body.classList.contains('mw-resizing') || split.classList.contains('is-dragging');
  });
  await page.mouse.up();
  const stuck = { during, after };
  expect(stuck).toEqual({ during: true, after: false });
});

test('switching language retranslates the page, including text set from code', async ({ page }) => {
  await gotoApp(page);
  await page.locator('#language').selectOption('ja_JP');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP');
  await expect(page.locator('#tab-maps')).toHaveText('1 マテリアル');
  await expect(page.locator('#name-preview')).toHaveText('m_example としてエクスポート');
  expect(await page.locator('[title]').count()).toBe(0);
});
