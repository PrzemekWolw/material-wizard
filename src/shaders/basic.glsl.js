import { SRGB } from './common.glsl.js';

export const BASIC = {
  linear: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
${SRGB}
void main() { o = vec4(toLin(texture(uTex, vUv).rgb), texture(uTex, vUv).a); }`,

  copy: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uFlip;
uniform float uGray;
void main() {
  vec4 c = texture(uTex, vUv);
  if (uFlip > 0.5) c.g = 1.0 - c.g;
  if (uGray > 0.5) c = vec4(c.rrr, 1.0);
  o = c;
}`,

  // Readback copy: rows come out top first. Packed gray puts the R of four pixels in one texel.
  readout: `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTex;
uniform float uGray;
uniform float uPack;
uniform vec4 uPick;
void main() {
  ivec2 size = textureSize(uTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  int y = size.y - 1 - p.y;
  if (uPack > 0.5) {
    vec4 v;
    for (int i = 0; i < 4; i++) v[i] = dot(texelFetch(uTex, ivec2(min(p.x * 4 + i, size.x - 1), y), 0), uPick);
    o = v;
    return;
  }
  vec4 c = texelFetch(uTex, ivec2(p.x, y), 0);
  o = uGray > 0.5 ? vec4(c.rrr, 1.0) : c;
}`,

  fill: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec4 uColor;
void main() { o = uColor; }`,

  blur: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.227027;
  c += texture(uTex, vUv + uStep).rgb * 0.1945946;
  c += texture(uTex, vUv - uStep).rgb * 0.1945946;
  c += texture(uTex, vUv + uStep * 2.0).rgb * 0.1216216;
  c += texture(uTex, vUv - uStep * 2.0).rgb * 0.1216216;
  o = vec4(c, 1.0);
}`,

  blurA: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  vec4 c = texture(uTex, vUv) * 0.227027;
  c += texture(uTex, vUv + uStep) * 0.1945946;
  c += texture(uTex, vUv - uStep) * 0.1945946;
  c += texture(uTex, vUv + uStep * 2.0) * 0.1216216;
  c += texture(uTex, vUv - uStep * 2.0) * 0.1216216;
  o = c;
}`,

  show: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uBefore;
uniform float uSplit;
uniform float uMode;
uniform float uRepeatX;
uniform float uRepeatY;
uniform float uSeam;
uniform float uZoom;
uniform vec2 uCenter;
uniform vec3 uMul;
${SRGB}
void main() {
  float zoom = max(uZoom, 1.0);
  vec2 q = (vUv - 0.5) / zoom + uCenter;
  vec2 uv = vec2(fract(q.x * uRepeatX), fract(q.y * uRepeatY));
  bool split = vUv.x < uSplit;
  vec3 lin = split ? texture(uBefore, uv).rgb : texture(uTex, uv).rgb * uMul;
  vec3 col = uMode < 0.5 ? toSRGB(lin) : (uMode < 1.5 ? lin : vec3(lin.r));
  if (uSeam > 0.5 && !split) {
    float sx = min(fract(q.x * uRepeatX), fract(q.y * uRepeatY));
    if (sx < 0.012 / zoom) col = mix(col, vec3(0.95, 0.35, 0.13), 0.85);
  }
  o = vec4(col, 1.0);
}`,

  meter: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uCell;
// Averages a 4x4 grid over the area of one meter texel.
void main() {
  vec4 c = vec4(0.0);
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) c += texture(uTex, vUv + (vec2(x, y) - 1.5) * 0.25 * uCell);
  }
  c /= 16.0;
  float y = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float v = floor(clamp((log2(max(y, 1e-6)) + 12.0) / 24.0, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(v / 256.0);
  o = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, c.a, 1.0);
}`,
};
