import { downloadBytes } from '../export.js';
import { run } from '../services/worker.js';
import { filesForCurrent } from './exporter.js';
import { text } from '../services/i18n.js';
import { SLOTS, slotImages, state } from '../services/state.js';
import { loadImage } from '../utils/images.js';

export function classify(filename) {
  const stem = filename.split('/').pop().replace(/\.[^.]+$/, '');
  const rules = [
    [/_b\.color$/i, 'albedo'],
    [/_nm\.normal$/i, 'normal'],
    [/_r\.dataR?$/i, 'roughness'],
    [/_m\.dataR?$/i, 'metallic'],
    [/_ao\.dataR?$/i, 'ao'],
    [/_o\.dataR?$/i, 'opacity'],
    [/(basecolor|albedo|diffuse|_color)$/i, 'albedo'],
    [/(normal|nrm|_normal)$/i, 'normal'],
    [/(height|displacement|disp)$/i, 'height'],
    [/(roughness|rough)$/i, 'roughness'],
    [/(metallic|metalness)$/i, 'metallic'],
    [/(_ao|occlusion)$/i, 'ao'],
    [/(opacity|alpha)$/i, 'opacity'],
  ];
  for (const [re, slot] of rules) {
    if (re.test(stem)) return { slot, base: stem.replace(re, '').replace(/[_\-\s]+$/, '') || stem };
  }
  return { slot: 'source', base: stem };
}

function groupFiles(fileList) {
  const groups = new Map();
  Array.from(fileList).forEach((file) => {
    if (!file.type.startsWith('image/') && !/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) return;
    const info = classify(file.name);
    const key = info.slot === 'source' ? info.base : info.base;
    if (!groups.has(key)) groups.set(key, { base: key || file.name, files: {} });
    const group = groups.get(key);
    if (info.slot === 'source') group.files.albedo = file;
    else group.files[info.slot] = file;
    if (!group.files.albedo && info.slot === 'source') group.files.albedo = file;
  });
  return Array.from(groups.values()).filter((group) => group.files.albedo || group.files.source);
}

async function runGroups(files, writer) {
  const groups = groupFiles(files);
  const list = document.getElementById('batch-list');
  list.innerHTML = '';
  const all = [];
  for (const [index, group] of groups.entries()) {
    const li = document.createElement('li');
    li.textContent = text('ui.materialWizard.notes.batchWork', { name: group.base });
    list.appendChild(li);
    try {
      const colorFile = group.files.albedo;
      if (!colorFile) throw new Error('no color image');
      state.original = await loadImage(colorFile);
      state.photoBytes = null;
      state.photoName = null;
      document.querySelector('[data-param="name"]').value = group.base.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+/, '') || 'm_material';
      for (const [name] of SLOTS) {
        slotImages[name] = null;
        document.querySelector('[data-slot-mode="' + name + '"]').value = name === 'albedo' ? 'load' : 'generate';
      }
      slotImages.albedo = state.original;
      if (group.files.normal) {
        slotImages.normal = await loadImage(group.files.normal);
        document.querySelector('[data-slot-mode="normal"]').value = 'load';
        document.querySelector('[data-param="addDetail"]').checked = true;
      }
      for (const slot of ['height', 'roughness', 'metallic', 'ao', 'opacity']) {
        if (group.files[slot]) {
          slotImages[slot] = await loadImage(group.files[slot]);
          document.querySelector('[data-slot-mode="' + slot + '"]').value = 'load';
        }
      }
      const produced = await filesForCurrent(group.base, index + 1);
      if (writer) await writer(group.base, produced);
      else all.push(...produced);
      li.textContent = text('ui.materialWizard.notes.batchDone', { name: group.base });
    } catch (error) {
      li.textContent = text('ui.materialWizard.notes.batchFail', { name: group.base });
    }
  }
  return all;
}

export function init() {
  document.getElementById('batch-folder').addEventListener('change', (event) => {
    const list = document.getElementById('batch-list');
    list.innerHTML = '';
    groupFiles(event.target.files).forEach((group) => {
      const li = document.createElement('li');
      li.textContent = text('ui.materialWizard.notes.batchLine', { name: group.base, files: Object.keys(group.files).join(', ') });
      list.appendChild(li);
    });
  });

  document.getElementById('run-batch').addEventListener('click', async () => {
    const input = document.getElementById('batch-folder');
    if (!input.files.length) return;
    const all = await runGroups(input.files, null);
    if (all.length) downloadBytes(await run('zip', { files: all }, { transfer: all.map((file) => file.data.buffer) }), 'material-wizard-batch.zip', 'application/zip');
  });

  document.getElementById('write-folder').addEventListener('click', async () => {
    const input = document.getElementById('batch-folder');
    if (!input.files.length || !window.showDirectoryPicker) {
      document.getElementById('run-batch').click();
      return;
    }
    const dir = await window.showDirectoryPicker();
    await runGroups(input.files, async (name, produced) => {
      const sub = await dir.getDirectoryHandle(name, { create: true });
      for (const file of produced) {
        const leaf = file.name.split('/').pop();
        const handle = await sub.getFileHandle(leaf, { create: true });
        const stream = await handle.createWritable();
        await stream.write(file.data);
        await stream.close();
      }
    });
  });
}
