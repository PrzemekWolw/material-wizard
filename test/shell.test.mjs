import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const list = (dir) => readdirSync(join(root, dir), { recursive: true })
  .filter((file) => /\.(js|css)$/.test(file))
  .map((file) => (dir + '/' + file).replaceAll('\\', '/'));

test('the offline cache lists every module, style and locale', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const shell = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
  const locales = readdirSync(join(root, 'locales')).map((lang) => 'locales/' + lang + '/main.translation.json');
  const missing = [...list('src'), ...list('styles'), ...locales, 'app.js', 'version.js'].filter((file) => !shell.has(file));
  assert.deepEqual(missing, []);
});

test('every local file the offline cache and the manifest name exists', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((file) => !/^(\.\/|\.\.\/|https:)/.test(file));
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
  const named = [...shell, ...manifest.icons.map((icon) => icon.src), ...manifest.screenshots.map((shot) => shot.src)];
  assert.deepEqual(named.filter((file) => !existsSync(join(root, file))), []);
  assert.deepEqual(manifest.screenshots.map((shot) => shot.form_factor).sort(), ['narrow', 'wide']);
});

test('index.html links every stylesheet', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.deepEqual(list('styles').filter((file) => !html.includes('href="./' + file + '"')), []);
});

test('index.html preloads the whole startup module graph', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const preloaded = new Set([...html.matchAll(/rel="modulepreload" href="\.\/([^"]+)"/g)].map((m) => m[1]));
  const graph = new Set();
  const walk = (file) => {
    if (graph.has(file)) return;
    graph.add(file);
    const src = readFileSync(join(root, file), 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/gm)) {
      walk(join(dirname(file), m[1]).replaceAll('\\', '/'));
    }
  };
  walk('app.js');
  graph.delete('app.js');
  assert.deepEqual([...graph].filter((file) => !preloaded.has(file)).sort(), [], 'missing');
  assert.deepEqual([...preloaded].filter((file) => !graph.has(file)).sort(), [], 'extra');
});
