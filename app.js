import { fillCopy, text, init as initI18n } from './src/services/i18n.js';
import { readParams, slotImages, state, init as initState } from './src/services/state.js';
import { init as initHistory } from './src/services/history.js';
import { fillPresetList, presetList, init as initPresets } from './src/services/presets.js';
import { syncHdrNote } from './src/modules/hdr.js';
import { engine, gpuLost, paintRanges, schedule, init as initRender } from './src/modules/render.js';
import { drawLights, init as initSun } from './src/modules/sun.js';
import { refreshEditor, repeatInfo, showRepeat, init as initTiling } from './src/modules/tiling.js';
import { init as initLayout } from './src/modules/layout.js';
import { init as initView } from './src/modules/view.js';
import { init as initSlots } from './src/modules/slots.js';
import { init as initCurve } from './src/modules/curve.js';
import { init as initTerrain } from './src/modules/terrain.js';
import { init as initLayers } from './src/modules/layers.js';
import { init as initZones } from './src/modules/zones.js';
import { init as initPhone } from './src/modules/phone.js';
import { captureStart, init as initProject } from './src/modules/project.js';
import { init as initPick } from './src/modules/pick.js';
import { syncNamePreview, init as initExporter } from './src/modules/exporter.js';
import { init as initBatch } from './src/modules/batch.js';
import { init as initTooltip } from './src/modules/tooltip.js';
import { finishStartup } from './src/services/progress.js';

function refreshLanguage() {
  document.querySelectorAll('[data-file-name]').forEach((el) => {
    if (!slotImages[el.dataset.fileName]) el.textContent = text('ui.materialWizard.maps.choose');
  });
  fillPresetList(presetList.value);
  if (repeatInfo) showRepeat();
  drawLights();
  refreshEditor();
  if (state.original && !gpuLost) schedule();
  syncHdrNote();
  syncNamePreview(readParams());
}

document.title = text('ui.materialWizard.pageTitle');
paintRanges();

initI18n(refreshLanguage);
initSun();
initLayout();
initView();
initSlots();
initCurve();
initTerrain();
initZones();
initState();
initPhone();
initHistory();
initLayers();
initPresets();
initRender();
initTiling();
initProject();
initPick();
initExporter();
initBatch();
initTooltip();
fillCopy(document);
captureStart();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('service worker failed', error));

engine.resize(1024, 1024);
finishStartup();
