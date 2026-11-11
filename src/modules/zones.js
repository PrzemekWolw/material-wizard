import { CLASSES } from '../engine/engine.js';
import { startPick } from './pick.js';
import { paintRange, schedule } from './render.js';
import { commit, remember } from '../services/history.js';
import { fillCopy } from '../services/i18n.js';
import { armResets, syncResets } from '../services/state.js';
import { hexLinear } from '../utils/color.js';
import { num } from '../utils/sizes.js';

const ZONE_COUNT = 6;

export const zoneHost = document.getElementById('zones');

export function zoneEl(i, field) {
  return zoneHost.querySelector('[data-zone="' + i + '"][data-zone-field="' + field + '"]');
}

function zoneSlider(i, field, copy, min, max, value, tip) {
  return '<label class="mw-field"' + (tip ? ' data-title="' + tip + '"' : '') + '><span data-copy="' + copy + '"></span>'
    + '<input type="range" data-zone="' + i + '" data-zone-field="' + field + '" min="' + min + '" max="' + max + '" step="0.01" value="' + value + '"></label>';
}

function zoneClassSelect(i) {
  return '<label class="mw-field"><span data-copy="ui.materialWizard.surface.material"></span><select data-zone="' + i + '" data-zone-field="class">'
    + Object.keys(CLASSES).map((name) => '<option value="' + name + '" data-copy="ui.materialWizard.classes.' + name + '"></option>').join('')
    + '</select></label>';
}

const zonesHead = document.createElement('h3');

export function syncZones() {
  for (let i = 1; i <= ZONE_COUNT; i++) {
    zoneHost.querySelector('[data-zone-row="' + i + '"]').hidden = !zoneEl(i, 'on').checked;
  }
}

export function readZones() {
  const num01 = (i, field) => num(zoneEl(i, field).value, 0);
  const zones = [];
  for (let i = 1; i <= ZONE_COUNT; i++) {
    if (!zoneEl(i, 'on').checked) continue;
    zones.push({ color: hexLinear(zoneEl(i, 'color').value), range: num01(i, 'range'), rough: num01(i, 'rough'), metal: num01(i, 'metal'), opacity: num01(i, 'opacity') });
  }
  return { base: [num01(0, 'rough'), num01(0, 'metal')], zones };
}

export function init() {
  for (let i = 0; i <= ZONE_COUNT; i++) {
    const row = document.createElement('div');
    row.className = 'mw-zone';
    row.dataset.zoneRow = String(i);
    row.innerHTML = i === 0
      ? '<h3 data-copy="ui.materialWizard.surface.base"></h3>' + zoneClassSelect(0)
        + zoneSlider(0, 'rough', 'ui.materialWizard.surface.roughness', 0, 1, 0.85)
        + zoneSlider(0, 'metal', 'ui.materialWizard.surface.metallic', 0, 1, 0)
      : '<div class="mw-slot-head"><h3 data-copy="ui.materialWizard.surface.zone" data-n="' + i + '"></h3>'
        + '<input type="checkbox" class="mw-hidden" data-zone="' + i + '" data-zone-field="on">'
        + '<button type="button" class="mw-round" data-zone-remove="' + i + '" data-title="ui.materialWizard.surface.removeZone"><i class="fa-solid fa-xmark"></i></button></div>'
        + '<div class="mw-row"><label class="mw-text"><span data-copy="ui.materialWizard.surface.zoneColor"></span> '
        + '<input type="color" data-zone="' + i + '" data-zone-field="color" value="#808080"></label>'
        + '<button type="button" data-zone-pick="' + i + '" data-copy="ui.materialWizard.surface.pick"></button></div>'
        + zoneSlider(i, 'range', 'ui.materialWizard.surface.range', 0.02, 0.6, 0.2, 'ui.materialWizard.surface.rangeTip')
        + zoneClassSelect(i)
        + zoneSlider(i, 'rough', 'ui.materialWizard.surface.roughness', 0, 1, 0.85)
        + zoneSlider(i, 'metal', 'ui.materialWizard.surface.metallic', 0, 1, 0)
        + zoneSlider(i, 'opacity', 'ui.materialWizard.surface.zoneOpacity', 0, 1, 1);
    zoneHost.appendChild(row);
  }
  zonesHead.className = 'mw-sub';
  zonesHead.dataset.copy = 'ui.materialWizard.surface.zones';
  zoneHost.insertBefore(zonesHead, zoneHost.querySelector('[data-zone-row="1"]'));
  fillCopy(zoneHost);
  zoneEl(0, 'class').value = 'asphalt';

  syncZones();
  armResets(document.body);
  syncResets();
  zoneHost.addEventListener('input', (event) => {
    const el = event.target;
    if (el.dataset.zoneField !== 'class') return;
    const info = CLASSES[el.value];
    zoneEl(el.dataset.zone, 'rough').value = info.rough;
    zoneEl(el.dataset.zone, 'metal').value = info.metal;
    paintRange(zoneEl(el.dataset.zone, 'rough'));
    paintRange(zoneEl(el.dataset.zone, 'metal'));
  });
  zoneHost.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-zone-remove]');
    if (remove) {
      remember();
      zoneEl(remove.dataset.zoneRemove, 'on').checked = false;
      syncZones();
      commit();
      schedule();
      return;
    }
    const pick = event.target.closest('[data-zone-pick]');
    if (pick) startPick(pick, Number(pick.dataset.zonePick));
  });
  document.getElementById('add-zone').addEventListener('click', () => {
    for (let i = 1; i <= ZONE_COUNT; i++) {
      if (zoneEl(i, 'on').checked) continue;
      remember();
      zoneEl(i, 'on').checked = true;
      syncZones();
      commit();
      schedule();
      return;
    }
  });

}
