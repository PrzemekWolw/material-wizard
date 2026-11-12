import { text } from './i18n.js';

const bar = document.getElementById('save-status');

const labelEl = bar.querySelector('.mw-progress-text');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let generation = 0;

let timer = 0;

// One strip for startup, opening and saving. A newer status cancels a hide that is still waiting.
export function showProgress(fraction, label, busy) {
  generation++;
  clearTimeout(timer);
  const appbar = document.getElementById('appbar');
  if (appbar && appbar.offsetHeight) document.body.style.setProperty('--mw-appbar-h', (window.innerHeight - appbar.getBoundingClientRect().top) + 'px');
  bar.hidden = false;
  bar.classList.remove('is-leaving');
  bar.classList.toggle('is-busy', !!busy);
  bar.style.setProperty('--mw-save', String(fraction));
  if (labelEl.textContent !== label) {
    labelEl.textContent = label;
    labelEl.classList.remove('mw-pop');
    void labelEl.offsetWidth;
    labelEl.classList.add('mw-pop');
  }
}

export function hideProgress(delay) {
  const mine = generation;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (mine !== generation) return;
    bar.classList.add('is-leaving');
    timer = setTimeout(() => {
      if (mine !== generation) return;
      bar.hidden = true;
      bar.classList.remove('is-leaving', 'is-busy');
    }, reducedMotion.matches ? 0 : 250);
  }, delay);
}

// The page paints this strip before the modules finish. Hide it once they have.
export function finishStartup() {
  hideProgress(0);
}

export async function trackOpen(file, fn) {
  const name = (file && file.name) || '';
  showProgress(0.2, text('ui.materialWizard.progress.opening', { name }), true);
  try {
    const value = await fn();
    showProgress(1, text('ui.materialWizard.progress.opened', { name }), false);
    hideProgress(1600);
    return value;
  } catch (error) {
    hideProgress(0);
    throw error;
  }
}
