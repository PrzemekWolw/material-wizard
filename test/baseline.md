# Baseline

Numbers before the overhaul, from `test/perf.spec.js` (1024 x 1024 photo, 1280 x 800 window, headless Chromium with SwiftShader, so the GPU numbers are software rendering and only useful as a relative measure). Run it with `npx playwright test perf` and read the `perf {...}` line.

| Measure | Before |
| --- | --- |
| Open to first frame | 9.0 s |
| Relief slider to new frame | 1.0 to 1.5 s |
| Base color to lit view | 230 to 340 ms |
| Sun dial to new frame | 200 to 290 ms |
| Export zip | 1.4 to 1.8 s |
| Save .mwz | 70 ms |
| Live texture memory | 161 MB |
| JS heap | 50 MB |

Line counts:

| File | Lines |
| --- | --- |
| app.js | 3337 |
| pbr.js | 2223 |
| tile.js | 695 |
| tile-editor.js | 678 |
| export.js | 233 |
| material-wizard.css | 939 |
| index.html | 611 |
| Total JS | 7166 |

After the module split (Phase 1) the JS is 7545 lines in 301 functions; the extra lines are imports and exports. After the cleanup (Phase 2) it is 7506 lines in 303 functions.

| Measure | Phase 3 (engine) | Phase 5 (frame loop, worker) |
| --- | --- | --- |
| Relief slider to new frame | 0.68 s | 0.61 s |
| Export zip | 0.53 s | 0.36 to 0.41 s |
| Save .mwz | 70 ms | 35 ms |
| Live texture memory | 66 MB | 67 MB |
| JS heap | 43 MB | 33 MB |

After the overhaul (Phase 9, perf spec alone with one worker, three runs):

| Measure | Before | After |
| --- | --- | --- |
| Open to first frame | 9.0 s | 8.9 to 9.4 s |
| Relief slider to new frame | 1.0 to 1.5 s | 0.60 to 0.62 s |
| Base color to lit view | 230 to 340 ms | 131 to 136 ms |
| Sun dial to new frame | 200 to 290 ms | 92 to 95 ms |
| Export zip | 1.4 to 1.8 s | 0.36 s |
| Save .mwz | 70 ms | 33 ms |
| Live texture memory | 161 MB | 67 MB |
| JS heap | 50 MB | 34 MB |

First frame is dominated by SwiftShader compiling the shaders, which software rendering does not parallelise. The JS (`app.js` and `src/`) is now 9318 lines including the terrain profile, the worker, levels and curves, bombing, tooltips and accessibility; the CSS is 1004 lines in `styles/`.

An 8192 export (`test/io.spec.js`) reads one map at a time: 256 MB for base color and normal, 64 MB for each packed gray map. Before, all maps were held at once and each was copied once more for the row flip.

The golden images in `test/golden` hold the output of the same build. `test/golden.spec.js` checks every later change against them; set `UPDATE_GOLDEN=1` to rewrite them after an intended change.
