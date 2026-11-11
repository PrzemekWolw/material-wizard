import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('locale keys match and every literal key exists', () => {
  const en = JSON.parse(read('locales/en_US/main.translation.json'));
  const used = new Set();
  const sources = readdirSync(join(root, 'src'), { recursive: true }).filter((file) => file.endsWith('.js')).map((file) => join('src', file));
  for (const file of ['index.html', 'app.js', ...sources]) {
    for (const key of read(file).matchAll(/ui\.materialWizard\.[A-Za-z0-9_.]*[A-Za-z0-9_](?![.\w])/g)) used.add(key[0]);
  }
  assert.deepEqual([...used].filter((key) => !(key in en)).sort(), []);
  for (const lang of ['pl_PL', 'es_ES', 'de_DE', 'it_IT', 'zh_CN', 'ja_JP']) {
    const keys = new Set(Object.keys(JSON.parse(read('locales/' + lang + '/main.translation.json'))));
    assert.deepEqual([...keys].filter((key) => !(key in en)).sort(), [], lang + ' extra');
    assert.deepEqual(Object.keys(en).filter((key) => !keys.has(key)).sort(), [], lang + ' missing');
  }
});
