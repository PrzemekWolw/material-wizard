import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const styles = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles');
const sheets = readdirSync(styles).filter((file) => file.endsWith('.css')).map((file) => [file, readFileSync(join(styles, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]);

test('styles are flat: no box-shadow', () => {
  for (const [file, css] of sheets) assert.ok(!/box-shadow/.test(css), file + ' uses box-shadow');
});

test('every :hover rule sits inside @media (hover: hover)', () => {
  for (const [file, css] of sheets) {
    const stack = [];
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '{') {
        const prelude = css.slice(start, i).trim();
        if (prelude.includes(':hover') && !prelude.startsWith('@')) {
          assert.ok(stack.some((p) => /^@media\s*\(hover:\s*hover\)/.test(p)), file + ': ' + prelude);
        }
        stack.push(prelude);
        start = i + 1;
      } else if (css[i] === '}') {
        stack.pop();
        start = i + 1;
      } else if (css[i] === ';') {
        start = i + 1;
      }
    }
  }
});
