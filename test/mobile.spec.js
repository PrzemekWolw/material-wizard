import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readProject } from '../src/export.js';
import { gotoApp, keepDrawingBuffer, openCanvas, trackErrors } from './helpers.js';

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

test('swiping the mobile app bar raises and lowers it, and its commands scroll when narrow', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await gotoApp(page);
  const swipe = (dy) => page.evaluate((dy) => {
    const bar = document.getElementById('appbar');
    const rect = bar.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + 20;
    const fire = (type, d) => bar.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: y + d }));
    fire('pointerdown', 0);
    fire('pointermove', dy / 2);
    fire('pointermove', dy);
    fire('pointerup', dy);
  }, dy);
  await swipe(-60);
  expect(await page.evaluate(() => document.body.classList.contains('mw-more-open'))).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.mw-viewbar')).display)).toBe('grid');
  await expect.poll(() => page.evaluate(() => {
    const sheet = document.querySelector('.mw-viewbar').getBoundingClientRect();
    return Math.round(Math.abs(sheet.bottom - document.getElementById('appbar').getBoundingClientRect().top));
  })).toBeLessThan(2);
  await swipe(60);
  await page.waitForFunction(() => !document.body.classList.contains('mw-more-open'));

  await page.setViewportSize({ width: 260, height: 700 });
  const scroll = await page.evaluate(() => {
    const cmds = document.querySelector('.mw-appbar-cmds');
    const more = document.querySelector('[data-app="more"]').getBoundingClientRect();
    return { overflow: cmds.scrollWidth > cmds.clientWidth, moreRight: more.right };
  });
  expect(scroll.overflow).toBe(true);
  expect(scroll.moreRight).toBeLessThanOrEqual(260);
});

test('the mobile save button saves the project and shows its progress', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 820 });
  await gotoApp(page);
  await openCanvas(page, (c) => {
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#806040';
    g.fillRect(0, 0, 128, 128);
  }, 'flat.png');
  await page.evaluate(() => {
    delete window.showSaveFilePicker;
    window.statusSeen = [];
    new MutationObserver(() => {
      const el = document.getElementById('save-status');
      if (!el.hidden) window.statusSeen.push(el.querySelector('.mw-progress-text').textContent);
    }).observe(document.getElementById('save-status'), { attributes: true, subtree: true, childList: true, characterData: true });
  });
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('[data-app="save"]').click()]);
  expect(file.suggestedFilename()).toMatch(/\.mwz$/);
  const project = await readProject(await readFile(await file.path()));
  expect(project.session.materialWizardSession).toBe(1);
  await expect(page.locator('#save-status .mw-progress-text')).toHaveText(/^saved .+\.mwz$/);
  const seen = await page.evaluate(() => window.statusSeen);
  expect(seen.some((label) => label.startsWith('saving'))).toBe(true);
  const box = await page.locator('#save-status').boundingBox();
  const bar = await page.locator('#appbar').boundingBox();
  expect(Math.round(box.y + box.height)).toBe(Math.round(bar.y));
  await expect(page.locator('#save-status')).toBeHidden({ timeout: 5000 });
});
