import { expect, test } from '@playwright/test';
import { gotoApp, keepDrawingBuffer, trackErrors } from './helpers.js';

test.beforeEach(({ page }) => keepDrawingBuffer(page));
trackErrors(test);

test('mobile pivot content follows the finger and turns the page', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await gotoApp(page);
  const state = await page.evaluate(async () => {
    const aside = document.querySelector('.mw-page > aside');
    const panel = aside.querySelector('[data-panel]:not(.mw-hidden)');
    const rect = panel.getBoundingClientRect();
    const x = rect.left + rect.width * 0.7;
    const y = rect.top + 40;
    const fire = (type, dx) => panel.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch', clientX: x + dx, clientY: y }));
    fire('pointerdown', 0);
    fire('pointermove', -20);
    fire('pointermove', -80);
    const dragging = panel.style.transform;
    const header = document.getElementById('tabs').style.transform;
    fire('pointerup', -120);
    return { dragging, header, active: document.querySelector('#tabs .is-active').dataset.tab, reset: panel.style.transform };
  });
  expect(state.dragging).toContain('translateX(-80px)');
  expect(state.header).toContain('translateX(');
  expect(state.active).toBe('fix');
  expect(state.reset).toBe('');
});

test('mobile app bar labels open and close', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await gotoApp(page);
  const more = page.locator('[data-app="more"]');
  await more.click();
  expect(await page.evaluate(() => document.body.classList.contains('mw-more-open'))).toBe(true);
  await more.click();
  expect(await page.evaluate(() => document.body.classList.contains('mw-more-closing'))).toBe(true);
  await page.waitForFunction(() => !document.body.classList.contains('mw-more-open'));
});
