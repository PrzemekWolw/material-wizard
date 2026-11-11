import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD, fieldBasis } from '../src/shaders/common.glsl.js';

// Runs the GLSL field() as JS, so the shader and the CPU fit cannot drift apart.
function glslField() {
  const js = FIELD
    .replace('float field(vec2 uv)', 'return function field(uv)')
    .replace(/\bfloat /g, 'const ')
    .replace(/\b(cos|sin)\(/g, 'Math.$1(')
    .replace(/uv\.x/g, 'uv[0]').replace(/uv\.y/g, 'uv[1]')
    .replace(/uPeriodic\.x/g, 'uPeriodic[0]').replace(/uPeriodic\.y/g, 'uPeriodic[1]');
  return (uFitA, uFitB, uPeriodic) => new Function('uFitA', 'uFitB', 'uPeriodic', 'dot', 'vec2', 'vec3', js)(
    uFitA, uFitB, uPeriodic,
    (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0),
    (...v) => v,
    (...v) => v,
  );
}

test('FIELD matches fieldBasis', () => {
  const make = glslField();
  const coef = [0.3, -0.7, 0.45, 0.2, -0.15];
  for (const periodic of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const field = make(coef.slice(0, 3), coef.slice(3), periodic);
    for (const [u, v] of [[0, 0], [0.25, 0.8], [0.5, 0.5], [0.9, 0.1], [1, 1]]) {
      const basis = fieldBasis(u, v, periodic);
      const cpu = coef.reduce((sum, c, i) => sum + c * basis[i + 1], 0);
      assert.ok(Math.abs(field([u, v]) - cpu) < 1e-6, `periodic ${periodic} at ${u},${v}`);
    }
  }
});
