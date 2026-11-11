import { downloadBytes, materialDocument, materialName, terrainDocument, terrainFiles, textureLengthFor } from '../export.js';
import { activeLayer, layerPhoto, otherLayer, switchLayer, withLayer } from './layers.js';
import { atOutputSize, engine, renderForExport } from './render.js';
import { text } from '../services/i18n.js';
import { readParams, state } from '../services/state.js';
import { run } from '../services/worker.js';
import { terrainValues } from '../utils/terrain.js';

const isGray = (fileName) => fileName.endsWith('.dataR.png');

// Encodes a read map in the worker, which takes over the pixel buffer.
function encode(image) {
  const data = image.gray || image.rgba;
  return run('png', { data, w: image.w, h: image.h, gray: !!image.gray, stride: image.stride }, { transfer: [data.buffer] });
}

// Reads one map at output size and encodes it.
function mapPng(key, fileName) {
  return encode(engine.readMap(key, isGray(fileName)));
}

// Detail and macro files by group: [detail read, macro read]. Gray maps are channels of the packed textures.
const TERRAIN_READS = {
  baseColor: [() => engine.readTerrain('detB'), () => engine.readTerrain('macB')],
  normal: [() => engine.readMap('normal'), () => engine.readTerrain('macN')],
  roughness: [() => engine.readTerrain('detD', 0), () => engine.readTerrain('macD', 0)],
  ao: [() => engine.readTerrain('detD', 1), () => engine.readTerrain('macD', 1)],
  height: [() => engine.readTerrain('detD', 2), () => engine.readTerrain('macD', 2)],
};

// The material name from the name, prefix and numbering pattern. n counts materials in a batch.
export function exportName(params, n = 1) {
  return materialName(params.namePattern, { prefix: params.prefix, name: params.name, n });
}

export function syncNamePreview(params) {
  document.getElementById('name-preview').textContent = text('ui.materialWizard.export.exportsAs', { name: exportName(params) });
}

function wantsOpacity(params) {
  const shaped = params.opacityEdge > 0 || params.opacityPatch > 0 || params.opacityCrack > 0 || params.zones.some((zone) => zone.opacity < 1);
  return params.profile === 'road' || params.slots.opacity.mode === 'load' || shaped;
}

function materialJson(params, name) {
  if (params.kind === 'terrain') {
    return JSON.stringify(terrainDocument({ name, folder: params.folder, groundmodel: params.tGround || 'GRASS', annotation: 'NATURE', terrain: terrainValues(params) }), null, 2);
  }
  return JSON.stringify(materialDocument({
    name,
    folder: params.folder,
    profile: params.profile,
    annotation: params.annotation,
    alphaRef: params.alphaRef,
    roughnessFactor: params.factors.roughness,
    metallicFactor: params.factors.metallic,
    opacityFactor: params.factors.opacity,
    normalMapStrength: params.factors.normal,
    baseColorFactor: params.slots.albedo.mode === 'flat' ? null : params.flatColor,
    includeOpacity: wantsOpacity(params),
  }), null, 2);
}

export async function filesForCurrent(subfolder, n = 1) {
  const params = readParams();
  const name = exportName(params, n);
  const prefix = subfolder ? subfolder + '/' : '';
  if (params.kind === 'terrain') {
    const back = activeLayer();
    if (!state.original && layerPhoto(otherLayer())) switchLayer(otherLayer(), { hold: false, render: false });
    const files = {};
    const readLayer = async (which) => {
      const made = {};
      for (const { group, detail, macro } of terrainFiles(name)) {
        const fileName = which === 'detail' ? detail : macro;
        made[fileName] = await encode(TERRAIN_READS[group][which === 'detail' ? 0 : 1]());
      }
      return made;
    };
    engine.useHeld(false);
    try {
      await atOutputSize(async () => {
        try {
          await renderForExport();
          const other = otherLayer();
          if (layerPhoto(other)) {
            Object.assign(files, await readLayer(activeLayer()));
            await withLayer(other, async () => {
              await renderForExport();
              Object.assign(files, await readLayer(other));
            });
          } else {
            Object.assign(files, await readLayer('detail'), await readLayer('macro'));
          }
        } finally {
          engine.useHeld(true);
        }
      });
    } finally {
      engine.useHeld(true);
      if (activeLayer() !== back) switchLayer(back, { hold: false, render: false });
    }
    const ordered = [];
    for (const { detail, macro } of terrainFiles(name)) {
      ordered.push({ name: prefix + detail, data: files[detail] });
      ordered.push({ name: prefix + macro, data: files[macro] });
    }
    ordered.push({ name: prefix + 'main.materials.json', data: new TextEncoder().encode(materialJson(params, name)) });
    return ordered;
  }
  const names = [
    ['albedo', name + '_b.color.png'],
    ['normal', name + '_nm.normal.png'],
    ['rough', name + '_r.dataR.png'],
    ['metal', name + '_m.dataR.png'],
    ['ao', name + '_ao.dataR.png'],
  ];
  if (wantsOpacity(params)) names.push(['opacity', name + '_o.dataR.png']);
  const files = [];
  const size = await atOutputSize(async (at) => {
    for (const [key, fileName] of names) files.push({ name: prefix + fileName, data: await mapPng(key, fileName) });
    return at;
  });
  files.push({ name: prefix + 'main.materials.json', data: new TextEncoder().encode(materialJson(params, name)) });
  if (params.profile === 'road') {
    const length = textureLengthFor(params.roadWidth, size.w, size.h);
    files.push({
      name: prefix + 'textureLength.txt',
      data: new TextEncoder().encode(text('ui.materialWizard.notes.lengthFile', { length: length.toFixed(3) })),
    });
  }
  return files;
}

const SAVE = {
  albedo: ['albedo', '_b.color.png', 'Base color'],
  height: ['height', '_h.dataR.png', 'Height'],
  normal: ['normal', '_nm.normal.png', 'Normal'],
  roughness: ['rough', '_r.dataR.png', 'Roughness'],
  metallic: ['metal', '_m.dataR.png', 'Metallic'],
  ao: ['ao', '_ao.dataR.png', 'AO'],
  opacity: ['opacity', '_o.dataR.png', 'Opacity'],
};

const saveHost = document.getElementById('save-maps');

export function init() {
  Object.keys(SAVE).forEach((slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.save = slot;
    button.innerHTML = '<i class="fa-solid fa-download"></i> <span data-copy="ui.materialWizard.slots.' + slot + '">' + text('ui.materialWizard.slots.' + slot) + '</span>';
    saveHost.appendChild(button);
  });
  document.body.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save]');
    if (!button || !state.original) return;
    const [key, suffix] = SAVE[button.dataset.save];
    const bytes = await atOutputSize(() => mapPng(key, suffix)).catch(() => null);
    if (!bytes) return;
    downloadBytes(bytes, exportName(readParams()) + suffix, 'image/png');
  });

  document.body.addEventListener('input', (event) => {
    if (event.target.matches('[data-param="name"], [data-param="prefix"], [data-param="namePattern"]')) syncNamePreview(readParams());
  });
  syncNamePreview(readParams());

  document.getElementById('copy-json').addEventListener('click', async () => {
    const params = readParams();
    const note = document.getElementById('copy-note');
    try {
      await navigator.clipboard.writeText(materialJson(params, exportName(params)));
      note.textContent = text('ui.materialWizard.export.copied');
    } catch (error) {
      console.warn('clipboard write failed', error);
      note.textContent = text('ui.materialWizard.export.copyFailed');
    }
  });

  document.getElementById('download').addEventListener('click', async () => {
    if (!state.original) return;
    const files = await filesForCurrent('');
    downloadBytes(await run('zip', { files }, { transfer: files.map((file) => file.data.buffer) }), exportName(readParams()) + '.zip', 'application/zip');
  });
}
