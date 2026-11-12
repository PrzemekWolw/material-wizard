import { setNameFrom, useImage } from './project.js';
import { schedule } from './render.js';
import { showView, slotThumbs, thumbCanvas } from './view.js';
import { commit, remember } from '../services/history.js';
import { text } from '../services/i18n.js';
import { trackOpen } from '../services/progress.js';
import { COLOR_SLOTS, FACTOR_SLOTS, SLOTS, VIEW_OF_SLOT, slotImages, warningsEl, state } from '../services/state.js';
import { extract, loadImage } from '../utils/images.js';
import { ADJUST_SLOTS, adjustMarkup } from './curve.js';

const slotHost = document.getElementById('slots');

export function setSlotMode(name, mode) {
  document.querySelector('[data-slot-mode="' + name + '"]').value = mode;
  syncSlot(name);
}

export function syncSlot(name) {
  const mode = document.querySelector('[data-slot-mode="' + name + '"]').value;
  const box = slotHost.querySelector('[data-slot="' + name + '"]');
  box.querySelectorAll('[data-mode]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.mode === mode);
    el.setAttribute('aria-pressed', String(el.dataset.mode === mode));
  });
  box.querySelectorAll('[data-when]').forEach((el) => el.classList.toggle('mw-hidden', el.dataset.when !== mode));
  document.querySelectorAll('[data-load-detail="' + name + '"]').forEach((el) => { el.hidden = mode !== 'load'; });
}

const orm = document.createElement('div');

export function init() {
  SLOTS.forEach(([name, flat]) => {
    const label = text('ui.materialWizard.slots.' + name);
    const modes = name === 'albedo'
      ? [['load', 'ui.materialWizard.modes.image'], ['flat', 'ui.materialWizard.modes.flat']]
      : [['generate', 'ui.materialWizard.modes.generate'], ['load', 'ui.materialWizard.modes.load'], ['flat', 'ui.materialWizard.modes.flat']];
    const box = document.createElement('div');
    box.className = 'mw-slot';
    box.dataset.slot = name;
    box.innerHTML = '<button type="button" class="mw-thumb mw-slot-thumb" data-view="' + VIEW_OF_SLOT[name] + '" data-title="ui.materialWizard.maps.show"></button>'
      + '<div class="mw-slot-body">'
      + '<div class="mw-slot-head"><h3 data-copy="ui.materialWizard.slots.' + name + '">' + label + '</h3>'
      + '<button type="button" class="mw-save mw-round" data-save="' + name + '" data-title="ui.materialWizard.maps.save" data-label="ui.materialWizard.maps.saveAs" data-label-slot="' + name + '" aria-label="' + text('ui.materialWizard.maps.saveAs', { name: label }) + '"><i class="fa-solid fa-download"></i></button></div>'
      + '<div class="mw-seg" data-seg="' + name + '">'
      + modes.map(([mode, key]) => '<button type="button" data-mode="' + mode + '" data-copy="' + key + '">' + text(key) + '</button>').join('')
      + '</div>'
      + '<select class="mw-hidden" data-slot-mode="' + name + '">'
      + modes.map(([mode, key]) => '<option value="' + mode + '" data-copy="' + key + '">' + text(key) + '</option>').join('')
      + '</select>'
      + '<div class="mw-row" data-when="load">'
      + '<label class="mw-file"><input type="file" data-slot-file="' + name + '" accept="image/*"><span data-file-name="' + name + '">' + text('ui.materialWizard.maps.choose') + '</span></label>'
      + (name === 'albedo' ? ''
        : '<select data-slot-channel="' + name + '" data-title="ui.materialWizard.maps.channel"><option value="rgb">RGB</option><option value="luma">luma</option><option value="r"' + (COLOR_SLOTS.includes(name) ? '' : ' selected') + '>R</option><option value="g">G</option><option value="b">B</option><option value="a">A</option></select>'
          + '<label class="mw-check"><input type="checkbox" data-slot-invert="' + name + '"> <span data-copy="ui.materialWizard.maps.invert">' + text('ui.materialWizard.maps.invert') + '</span></label>')
      + '</div>'
      + (name === 'albedo'
        ? '<label class="mw-field" data-title="ui.materialWizard.maps.colorTip"><span data-copy="ui.materialWizard.maps.color">' + text('ui.materialWizard.maps.color') + '</span>'
          + '<input type="color" data-slot-color="albedo" value="#ffffff"></label>'
        : '<label class="mw-field" data-when="flat"><span data-copy="ui.materialWizard.maps.value">' + text('ui.materialWizard.maps.value') + '</span>'
          + '<input type="range" data-slot-flat="' + name + '" min="0" max="1" step="0.01" value="' + flat + '"></label>')
      + (FACTOR_SLOTS[name]
        ? '<label class="mw-field" data-title="ui.materialWizard.maps.factorTip"><span data-copy="' + FACTOR_SLOTS[name].copy + '">' + text(FACTOR_SLOTS[name].copy) + '</span>'
          + '<input type="range" data-slot-factor="' + name + '" min="0" max="' + FACTOR_SLOTS[name].max + '" step="0.01" value="1"></label>'
        : '')
      + (ADJUST_SLOTS.includes(name) ? adjustMarkup(name) : '')
      + '</div>';
    slotHost.appendChild(box);
    const c = thumbCanvas();
    slotThumbs[name] = c;
    box.querySelector('.mw-slot-thumb').appendChild(c);
  });
  slotHost.addEventListener('click', (event) => {
    const seg = event.target.closest('[data-mode]');
    if (seg) {
      const name = seg.parentElement.dataset.seg;
      remember();
      if (seg.dataset.mode === 'load' && !slotImages[name]) {
        document.querySelector('[data-slot-file="' + name + '"]').click();
      }
      setSlotMode(name, seg.dataset.mode);
      commit();
      schedule();
      return;
    }
    const thumb = event.target.closest('[data-view]');
    if (thumb) showView(thumb.dataset.view);
  });

  SLOTS.forEach(([name]) => syncSlot(name));
  orm.className = 'mw-actions mw-orm';
  orm.innerHTML = '<label class="mw-text"><span data-copy="ui.materialWizard.maps.unpack">' + text('ui.materialWizard.maps.unpack') + '</span> <input type="file" id="orm-file" accept="image/*"></label>'
    + '<select id="orm-order"><option value="orm" data-copy="ui.materialWizard.maps.orm">' + text('ui.materialWizard.maps.orm') + '</option><option value="arm" data-copy="ui.materialWizard.maps.rma">' + text('ui.materialWizard.maps.rma') + '</option></select>';
  slotHost.appendChild(orm);
  async function openTracked(file, fn) {
    try {
      await trackOpen(file, fn);
    } catch (error) {
      console.warn('open failed', error);
      warningsEl.textContent = text('ui.materialWizard.notes.badFile', { name: file.name });
    }
  }
  document.body.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-slot-file]');
    if (!input || !input.files[0]) return;
    const slot = input.dataset.slotFile;
    const file = input.files[0];
    await openTracked(file, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = await loadImage(new Blob([bytes], { type: file.type || 'image/png' }));
      if (slot === 'albedo') {
        useImage(image, file, bytes);
        return;
      }
      remember();
      slotImages[slot] = image;
      document.querySelector('[data-file-name="' + slot + '"]').textContent = file.name;
      document.querySelector('[data-slot-mode="' + slot + '"]').value = 'load';
      if (!state.original) {
        state.original = image;
        setNameFrom(file);
      }
      commit();
      schedule();
    });
  });
  document.getElementById('mask-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) {
      remember();
      event.target._image = null;
      commit();
      schedule();
      return;
    }
    await openTracked(file, async () => {
      remember();
      event.target._image = await loadImage(file);
      commit();
      schedule();
    });
  });
  document.getElementById('orm-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await openTracked(file, async () => {
      remember();
      const image = await loadImage(file);
      const order = document.getElementById('orm-order').value;
      const map = order === 'arm'
        ? { roughness: 'r', metallic: 'g', ao: 'b' }
        : { ao: 'r', roughness: 'g', metallic: 'b' };
      Object.keys(map).forEach((slot) => {
        slotImages[slot] = extract(image, map[slot], false);
        document.querySelector('[data-slot-mode="' + slot + '"]').value = 'load';
        document.querySelector('[data-slot-channel="' + slot + '"]').value = 'r';
      });
      if (!state.original) state.original = image;
      commit();
      schedule();
    });
  });
}
