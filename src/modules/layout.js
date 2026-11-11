import { VERSION } from '../../version.js';
import { mobile, reducedMotion } from './phone.js';
import { cancelPick } from './pick.js';
import { flushTileWork } from './render.js';
import { refreshEditor } from './tiling.js';
import { showView } from './view.js';
import { drop } from '../services/state.js';

const root = document.documentElement;

const themeKey = 'theme';

function themeMode() {
  let mode = null;
  try { mode = localStorage.getItem(themeKey); } catch (e) { /* ignore */ }
  if (mode !== 'dark' && mode !== 'light') mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return mode;
}

function applyTheme(mode) {
  root.setAttribute('data-theme', mode);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim());
  const toggle = document.getElementById('theme-toggle');
  toggle.firstElementChild.className = mode === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon';
  try { localStorage.setItem(themeKey, mode); } catch (e) { /* ignore */ }
}

const topBar = document.querySelector('.mw-top');

function syncTopHeight() {
  root.style.setProperty('--mw-top-h', topBar.offsetHeight + 'px');
}

const pageEl = document.querySelector('.mw-page');

const splitEl = document.getElementById('split');

const splitKey = 'mw-preview-width';

const SPLIT_W = 24;

let leftWidth = null;

function pageInner() {
  const style = getComputedStyle(pageEl);
  return pageEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

function applySplit() {
  if (!leftWidth) { pageEl.style.gridTemplateColumns = ''; return; }
  const max = pageInner() - SPLIT_W - 280;
  const width = Math.max(240, Math.min(max, leftWidth));
  pageEl.style.gridTemplateColumns = width + 'px ' + SPLIT_W + 'px minmax(280px, 1fr)';
}

function saveSplit() {
  try {
    if (leftWidth) localStorage.setItem(splitKey, String(Math.round(leftWidth)));
    else localStorage.removeItem(splitKey);
  } catch (e) { /* ignore */ }
}

function stageWidth() {
  return document.querySelector('.mw-stage').getBoundingClientRect().width;
}

function endSplit(event) {
  if (!splitEl.hasPointerCapture(event.pointerId)) return;
  splitEl.releasePointerCapture(event.pointerId);
  splitEl.classList.remove('is-dragging');
  document.body.classList.remove('mw-resizing');
  leftWidth = stageWidth();
  saveSplit();
}

const splitHEl = document.getElementById('split-h');

const splitHKey = 'mw-preview-height';

let previewHeight = null;

function applySplitH() {
  if (!previewHeight) { drop.style.flex = ''; return; }
  const stage = drop.parentElement.getBoundingClientRect();
  const above = drop.getBoundingClientRect().top - stage.top;
  const max = stage.height - above - splitHEl.offsetHeight;
  drop.style.flex = '0 0 ' + Math.max(160, Math.min(max, previewHeight)) + 'px';
}

function saveSplitH() {
  try {
    if (previewHeight) localStorage.setItem(splitHKey, String(Math.round(previewHeight)));
    else localStorage.removeItem(splitHKey);
  } catch (e) { /* ignore */ }
}

function endSplitH(event) {
  if (!splitHEl.hasPointerCapture(event.pointerId)) return;
  splitHEl.releasePointerCapture(event.pointerId);
  splitHEl.classList.remove('is-dragging');
  document.body.classList.remove('mw-resizing-h');
  previewHeight = drop.getBoundingClientRect().height;
  saveSplitH();
}

const TAB_VIEW = { albedo: 'albedo', shape: 'height', surface: 'rough', export: 'preview' };

function enterContent(panel, back) {
  Array.from(panel.children).forEach((child, i) => child.style.setProperty('--i', Math.min(i, 10)));
  panel.style.setProperty('--mw-from', back ? '-40px' : '40px');
  panel.classList.remove('mw-enter');
  void panel.offsetWidth;
  panel.classList.add('mw-enter');
}

const menuButtons = Array.from(document.querySelectorAll('[data-menu]'));

const flyoutOf = (button) => document.querySelector('[data-flyout="' + button.dataset.menu + '"]');

export function closeMenus() {
  menuButtons.forEach((button) => {
    flyoutOf(button).hidden = true;
    button.setAttribute('aria-expanded', 'false');
  });
}

export let installPrompt = null;

const installItems = document.querySelectorAll('[data-install]');

export function init() {
  applyTheme(themeMode());
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  syncTopHeight();
  new ResizeObserver(syncTopHeight).observe(topBar);

  try { leftWidth = Number(localStorage.getItem(splitKey)) || null; } catch (e) { /* ignore */ }

  splitEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitEl.setPointerCapture(event.pointerId);
    splitEl.classList.add('is-dragging');
    document.body.classList.add('mw-resizing');
  });
  splitEl.addEventListener('pointermove', (event) => {
    if (!splitEl.hasPointerCapture(event.pointerId)) return;
    const left = pageEl.getBoundingClientRect().left + parseFloat(getComputedStyle(pageEl).paddingLeft);
    leftWidth = event.clientX - left - SPLIT_W / 2;
    applySplit();
  });
  splitEl.addEventListener('pointerup', endSplit);
  splitEl.addEventListener('pointercancel', endSplit);
  splitEl.addEventListener('dblclick', () => {
    leftWidth = null;
    applySplit();
    saveSplit();
  });
  splitEl.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    leftWidth = stageWidth() + (event.key === 'ArrowRight' ? 40 : -40);
    applySplit();
    leftWidth = stageWidth();
    saveSplit();
  });
  window.addEventListener('resize', applySplit);
  applySplit();

  try { previewHeight = Number(localStorage.getItem(splitHKey)) || null; } catch (e) { /* ignore */ }

  splitHEl.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitHEl.setPointerCapture(event.pointerId);
    splitHEl.classList.add('is-dragging');
    document.body.classList.add('mw-resizing-h');
  });
  splitHEl.addEventListener('pointermove', (event) => {
    if (!splitHEl.hasPointerCapture(event.pointerId)) return;
    previewHeight = event.clientY - drop.getBoundingClientRect().top;
    applySplitH();
  });
  splitHEl.addEventListener('pointerup', endSplitH);
  splitHEl.addEventListener('pointercancel', endSplitH);
  splitHEl.addEventListener('dblclick', () => {
    previewHeight = null;
    applySplitH();
    saveSplitH();
  });
  splitHEl.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    previewHeight = drop.getBoundingClientRect().height + (event.key === 'ArrowDown' ? 40 : -40);
    applySplitH();
    previewHeight = drop.getBoundingClientRect().height;
    saveSplitH();
  });
  applySplitH();
  document.getElementById('tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    const previous = document.querySelector('[data-tab].is-active');
    const wasTile = previous.dataset.tab === 'tile';
    const tabs = Array.from(document.querySelectorAll('#tabs [data-tab]'));
    const back = tabs.indexOf(button) < tabs.indexOf(previous);
    document.querySelectorAll('[data-tab]').forEach((el) => {
      el.classList.toggle('is-active', el === button);
      el.setAttribute('aria-selected', String(el === button));
      el.tabIndex = el === button ? 0 : -1;
    });
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      const show = panel.getAttribute('data-panel') === button.dataset.tab;
      panel.classList.toggle('mw-hidden', !show);
      if (show) enterContent(panel, back);
    });
    if (TAB_VIEW[button.dataset.tab]) showView(TAB_VIEW[button.dataset.tab]);
    if (mobile.matches) {
      const bar = button.parentElement;
      bar.scrollTo({ left: bar.scrollLeft + button.getBoundingClientRect().left - bar.getBoundingClientRect().left, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
    if (wasTile && button.dataset.tab !== 'tile') flushTileWork();
    refreshEditor();
  });

  document.getElementById('tabs').addEventListener('keydown', (event) => {
    const tabs = Array.from(document.querySelectorAll('#tabs [data-tab]'));
    const i = tabs.indexOf(event.target);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next == null) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.click();
    tab.focus();
  });

  document.querySelector('[data-panel="albedo"]').addEventListener('input', (event) => {
    if (event.target.type === 'range' && event.target.dataset.param !== 'shadowFix' && event.target.dataset.param !== 'lightRange' && event.target.dataset.param !== 'lightStrength') document.querySelector('[data-param="albedoFix"]').checked = true;
  }, true);

  menuButtons.forEach((button) => button.addEventListener('click', () => {
    const flyout = flyoutOf(button);
    const open = flyout.hidden;
    closeMenus();
    if (!open) return;
    flyout.hidden = false;
    const rect = button.getBoundingClientRect();
    flyout.style.top = rect.bottom + 'px';
    flyout.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - flyout.offsetWidth)) + 'px';
    button.setAttribute('aria-expanded', 'true');
  }));
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.mw-flyout, [data-menu]')) closeMenus();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMenus();
    cancelPick();
  });
  document.getElementById('app-version').textContent = 'Material Wizard ' + VERSION;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    installItems.forEach((el) => { el.hidden = false; });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installItems.forEach((el) => { el.hidden = true; });
  });
}
