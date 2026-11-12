import { downloadBytes } from '../export.js';
import { VERSION, versionNewer } from '../../version.js';
import { schedule } from '../modules/render.js';
import { syncSlot } from '../modules/slots.js';
import { syncZones } from '../modules/zones.js';
import { commit, remember } from './history.js';
import { text } from './i18n.js';
import { hideProgress, showProgress } from './progress.js';
import { SLOTS, showFileNote, syncResets, state } from './state.js';

const PRESET_KEY = 'mw-presets';

const PRESET_SKIP = new Set(['shape', 'layout', 'seamLines', 'split', 'name', 'crop', 'previewSize', 'alphaView']);

export const presetList = document.getElementById('preset-list');

const presetName = document.getElementById('preset-name');

function storedPresets() {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY));
    if (raw && typeof raw === 'object') return raw;
  } catch (e) { /* ignore */ }
  return {};
}

function controlValue(el) {
  return el.type === 'checkbox' ? el.checked : el.value;
}

const SLOT_CONTROLS = '[data-slot-mode], [data-slot-channel], [data-slot-invert], [data-slot-flat], [data-slot-color], [data-slot-factor]';

function slotControlKey(el) {
  const d = el.dataset;
  if (d.slotMode != null) return 'mode:' + d.slotMode;
  if (d.slotChannel != null) return 'channel:' + d.slotChannel;
  if (d.slotInvert != null) return 'invert:' + d.slotInvert;
  if (d.slotColor != null) return 'color:' + d.slotColor;
  if (d.slotFactor != null) return 'factor:' + d.slotFactor;
  return 'flat:' + d.slotFlat;
}

export function readValues(all) {
  const values = {};
  document.querySelectorAll('[data-param]').forEach((el) => {
    if (all || !PRESET_SKIP.has(el.dataset.param)) values['p:' + el.dataset.param] = controlValue(el);
  });
  document.querySelectorAll(SLOT_CONTROLS).forEach((el) => {
    values['s:' + slotControlKey(el)] = controlValue(el);
  });
  document.querySelectorAll('[data-zone]').forEach((el) => {
    values['z:' + el.dataset.zone + ':' + el.dataset.zoneField] = controlValue(el);
  });
  values.quad = document.getElementById('quad').value;
  values.orm = document.getElementById('orm-order').value;
  return values;
}

function migrateValues(values) {
  if (values && values['p:mapDetailSize'] != null) {
    ['aoDetailSize', 'roughDetailSize', 'metalDetailSize'].forEach((name) => {
      if (values['p:' + name] == null) values['p:' + name] = values['p:mapDetailSize'];
    });
  }
  return values;
}

export function writePreset(values) {
  migrateValues(values);
  document.querySelectorAll('[data-param]').forEach((el) => setControl(el, values['p:' + el.dataset.param]));
  document.querySelectorAll(SLOT_CONTROLS).forEach((el) => {
    setControl(el, values['s:' + slotControlKey(el)]);
  });
  document.querySelectorAll('[data-zone]').forEach((el) => {
    setControl(el, values['z:' + el.dataset.zone + ':' + el.dataset.zoneField]);
  });
  syncZones();
  syncResets();
  if (values.quad != null) document.getElementById('quad').value = values.quad;
  if (values.orm != null) document.getElementById('orm-order').value = values.orm;
}

function setControl(el, value) {
  if (value == null) return;
  if (el.type === 'checkbox') el.checked = value === true || value === 'true';
  else el.value = value;
}

export function fillPresetList(selected) {
  const presets = storedPresets();
  presetList.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = text('ui.materialWizard.presets.none');
  presetList.appendChild(none);
  Object.keys(presets).sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    presetList.appendChild(option);
  });
  presetList.value = selected && presets[selected] ? selected : '';
  document.getElementById('preset-delete').disabled = !presetList.value;
}

function applyPreset(values) {
  remember();
  state.restoring = true;
  writePreset(values);
  state.restoring = false;
  SLOTS.forEach(([name]) => syncSlot(name));
  commit();
  schedule();
}

const presetFile = document.getElementById('preset-file');

export function init() {
  fillPresetList('');
  presetList.addEventListener('change', () => {
    const values = storedPresets()[presetList.value];
    document.getElementById('preset-delete').disabled = !values;
    if (!values) return;
    presetName.value = presetList.value;
    applyPreset(values);
  });
  document.getElementById('preset-save').addEventListener('click', () => {
    const name = (presetName.value.trim() || presetList.value).slice(0, 40);
    if (!name) { presetName.focus(); return; }
    const presets = storedPresets();
    presets[name] = readValues(false);
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) { /* ignore */ }
    presetName.value = name;
    fillPresetList(name);
  });
  document.getElementById('preset-delete').addEventListener('click', () => {
    if (!presetList.value) return;
    const presets = storedPresets();
    delete presets[presetList.value];
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) { /* ignore */ }
    presetName.value = '';
    fillPresetList('');
  });
  document.getElementById('preset-export').addEventListener('click', () => {
    const all = storedPresets();
    const name = presetList.value;
    const presets = name ? { [name]: all[name] } : all;
    if (!Object.keys(presets).length) return;
    const json = JSON.stringify({ materialWizardPresets: 1, version: VERSION, presets });
    const file = (name || 'material-wizard-presets').replace(/[^a-z0-9_-]+/gi, '_') + '.mwpreset.json';
    downloadBytes(new TextEncoder().encode(json), file, 'application/json');
  });
  document.getElementById('preset-import').addEventListener('click', () => presetFile.click());
  presetFile.addEventListener('change', async () => {
    const file = presetFile.files[0];
    presetFile.value = '';
    if (!file) return;
    showProgress(0.3, text('ui.materialWizard.progress.opening', { name: file.name }), true);
    let incoming = null;
    try {
      const parsed = JSON.parse(await file.text());
      incoming = parsed.presets;
      if (versionNewer(parsed.version)) state.sessionNote = text('ui.materialWizard.notes.newerFile', { v: parsed.version });
    } catch (e) { /* not a preset file */ }
    if (!incoming || typeof incoming !== 'object') {
      hideProgress(0);
      showFileNote(text('ui.materialWizard.notes.badFile', { name: file.name }));
      return;
    }
    const presets = Object.assign(storedPresets(), incoming);
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (e) { /* ignore */ }
    fillPresetList(Object.keys(incoming)[0]);
    showProgress(1, text('ui.materialWizard.progress.opened', { name: file.name }), false);
    hideProgress(1600);
  });
}
