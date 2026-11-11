import { text } from '../services/i18n.js';

// One shared tooltip for every [data-title]: after a hover delay with a mouse, or at once on keyboard focus.
const HOVER_DELAY = 500;
const GAP = 6;

const tip = document.createElement('div');
tip.id = 'mw-tip';
tip.className = 'mw-tip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;

let owner = null;
let timer = 0;
let hideTimer = 0;

function place(target) {
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const x = Math.min(Math.max(GAP, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - GAP);
  const above = r.top - t.height - GAP;
  const y = above >= GAP ? above : Math.min(r.bottom + GAP, window.innerHeight - t.height - GAP);
  tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
}

export function showTip(target) {
  clearTimeout(timer);
  clearTimeout(hideTimer);
  const value = text(target.dataset.title);
  if (!value) return;
  if (owner && owner !== target) owner.removeAttribute('aria-describedby');
  owner = target;
  tip.textContent = value;
  tip.hidden = false;
  tip.classList.add('is-shown');
  place(target);
  target.setAttribute('aria-describedby', tip.id);
}

export function hideTip() {
  clearTimeout(timer);
  if (!owner) return;
  owner.removeAttribute('aria-describedby');
  owner = null;
  tip.classList.remove('is-shown');
  hideTimer = setTimeout(() => { tip.hidden = true; }, 170);
}

const titled = (node) => (node instanceof Element ? node.closest('[data-title]') : null);

export function init() {
  document.body.appendChild(tip);
  const canHover = window.matchMedia('(hover: hover)');
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse' || !canHover.matches) return;
    const target = titled(event.target);
    if (target === owner) return;
    clearTimeout(timer);
    if (!target) {
      hideTip();
      return;
    }
    timer = setTimeout(() => showTip(target), owner ? 0 : HOVER_DELAY);
  });
  document.addEventListener('pointerout', (event) => { if (!event.relatedTarget) hideTip(); });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('focusin', (event) => {
    const target = titled(event.target);
    if (target && event.target.matches(':focus-visible')) showTip(target);
    else hideTip();
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, true);
}
