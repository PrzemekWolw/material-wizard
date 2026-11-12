import { pickAndOpen, saveProject } from './project.js';
import { showView, viewSelect } from './view.js';
import { redo, undo } from '../services/history.js';
import { state } from '../services/state.js';

export const appbar = document.getElementById('appbar');

export const mobile = window.matchMedia('(max-width: 900px)');

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let compareView = null;

const compareButton = appbar.querySelector('[data-app="compare"]');

// Pivot swipe: the open panel and the header strip follow the finger, then snap back or turn the page.

let swipeFrom = null;

let swipeDragged = false;

const aside = document.querySelector('.mw-page > aside');

const tabsBar = document.getElementById('tabs');

const tabOrder = () => Array.from(document.querySelectorAll('#tabs [data-tab]'));

const activePanel = () => aside.querySelector('[data-panel]:not(.mw-hidden)');

function swipeTarget(dx) {
  const tabs = tabOrder();
  const index = tabs.findIndex((tab) => tab.classList.contains('is-active'));
  return tabs[index + (dx < 0 ? 1 : -1)] || null;
}

function moveSwipe(dx) {
  const panel = activePanel();
  const pull = swipeTarget(dx) ? dx : dx * 0.3;
  const fade = Math.min(1, Math.abs(pull) / aside.clientWidth);
  if (panel) {
    panel.style.transform = 'translateX(' + pull + 'px)';
    panel.style.opacity = String(1 - fade * 0.6);
  }
  tabsBar.style.transform = 'translateX(' + pull * 0.35 + 'px)';
}

function endSwipe(animate) {
  if (reducedMotion.matches) animate = false;
  [activePanel(), tabsBar].forEach((el) => {
    if (!el) return;
    el.classList.toggle('mw-swipe-back', animate);
    el.style.transform = '';
    el.style.opacity = '';
  });
  if (animate) setTimeout(() => aside.querySelectorAll('.mw-swipe-back').forEach((el) => el.classList.remove('mw-swipe-back')), 260);
}

// The raised app bar: labels under the commands and the view sheet above it.

const viewbar = document.querySelector('.mw-viewbar');

let barFrom = null;

let barDragged = false;

let closing = 0;

function measureBars() {
  const body = document.body;
  body.style.setProperty('--mw-appbar-h', innerHeight - appbar.getBoundingClientRect().top + 'px');
  body.style.setProperty('--mw-sheet-h', (body.classList.contains('mw-more-open') ? viewbar.offsetHeight : 0) + 'px');
}

export function setMore(open) {
  const body = document.body;
  if (open === body.classList.contains('mw-more-open') && !closing) return;
  clearTimeout(closing);
  closing = 0;
  body.classList.remove('mw-more-closing');
  if (open) {
    body.classList.add('mw-more-open');
    measureBars();
    return;
  }
  body.classList.add('mw-more-closing');
  closing = setTimeout(() => {
    closing = 0;
    body.classList.remove('mw-more-open', 'mw-more-closing');
    measureBars();
  }, reducedMotion.matches ? 0 : 160);
}

export function init() {
  appbar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-app]');
    if (!button) return;
    const action = button.dataset.app;
    if (action === 'open') pickAndOpen();
    else if (action === 'undo') undo();
    else if (action === 'redo') redo();
    else if (action === 'save') saveProject(false);
    else if (action === 'more') setMore(!document.body.classList.contains('mw-more-open'));
  });
  new ResizeObserver(measureBars).observe(appbar);
  new ResizeObserver(measureBars).observe(viewbar);

  appbar.addEventListener('pointerdown', (event) => {
    barDragged = false;
    barFrom = event.isPrimary ? { x: event.clientX, y: event.clientY, vertical: null } : null;
  });
  appbar.addEventListener('pointermove', (event) => {
    if (!barFrom) return;
    const dx = event.clientX - barFrom.x;
    const dy = event.clientY - barFrom.y;
    if (barFrom.vertical === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      barFrom.vertical = Math.abs(dy) > Math.abs(dx) * 1.5;
      if (!barFrom.vertical) { barFrom = null; return; }
    }
    if (Math.abs(dy) < 24) return;
    barDragged = true;
    barFrom = null;
    setMore(dy < 0);
  });
  ['pointerup', 'pointercancel'].forEach((type) => appbar.addEventListener(type, () => { barFrom = null; }));
  appbar.addEventListener('click', (event) => {
    if (!barDragged) return;
    barDragged = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  compareButton.addEventListener('pointerdown', () => {
    if (compareView || !state.original) return;
    compareView = viewSelect.value;
    showView('source');
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => compareButton.addEventListener(type, () => {
    if (!compareView) return;
    showView(compareView);
    compareView = null;
  }));

  aside.addEventListener('pointerdown', (event) => {
    swipeDragged = false;
    swipeFrom = mobile.matches && event.isPrimary && !event.target.closest('input, select, textarea, canvas, .mw-tabs')
      ? { x: event.clientX, y: event.clientY, horizontal: null } : null;
  });
  aside.addEventListener('pointermove', (event) => {
    if (!swipeFrom) return;
    const dx = event.clientX - swipeFrom.x;
    const dy = event.clientY - swipeFrom.y;
    if (swipeFrom.horizontal === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      swipeFrom.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
    }
    if (!swipeFrom.horizontal) return;
    swipeDragged = true;
    moveSwipe(dx);
  });
  aside.addEventListener('pointerup', (event) => {
    if (!swipeFrom) return;
    const dx = event.clientX - swipeFrom.x;
    const horizontal = swipeFrom.horizontal;
    swipeFrom = null;
    if (!horizontal) return;
    const next = Math.abs(dx) >= 60 ? swipeTarget(dx) : null;
    endSwipe(!next);
    if (next) next.click();
  });
  aside.addEventListener('pointercancel', () => {
    if (!swipeFrom) return;
    swipeFrom = null;
    endSwipe(true);
  });
  aside.addEventListener('click', (event) => {
    if (!swipeDragged) return;
    swipeDragged = false;
    if (!event.target.closest('.mw-tabs')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}
