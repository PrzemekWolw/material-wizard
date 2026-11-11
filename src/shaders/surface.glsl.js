import { SRGB } from './common.glsl.js';

export const SURFACE = {
  height: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uAlb;
uniform sampler2D uSrc;
uniform sampler2D uB0;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform sampler2D uB3;
uniform float uReliefMix;
uniform float uContrast;
uniform float uBias;
uniform float uShadeScale;
uniform vec4 uW;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  float y = luma(texture(uAlb, vUv).rgb);
  float src = luma(texture(uSrc, vUv).rgb);
  float b0 = luma(texture(uB0, vUv).rgb);
  float b1 = luma(texture(uB1, vUv).rgb);
  float b2 = luma(texture(uB2, vUv).rgb);
  float b3 = max(luma(texture(uB3, vUv).rgb), 0.02);
  float wsum = max(0.001, uW.x + uW.y + uW.z + uW.w);
  float rel = ((y / b3 - 1.0) * uW.x + (b0 / b3 - 1.0) * uW.y + (b1 / b3 - 1.0) * uW.z + (b2 / b3 - 1.0) * uW.w) / wsum;
  float h = clamp(0.5 + rel * 0.5, 0.0, 1.0);
  float shade = clamp(src / max(y, 0.02) * uShadeScale, 0.0, 2.0);
  float removed = clamp(0.5 + (shade - 1.0) * 0.5, 0.0, 1.0);
  h = mix(h, removed, uReliefMix);
  h = clamp((h - 0.5) * uContrast + 0.5 + uBias, 0.0, 1.0);
  o = vec4(vec3(h), 1.0);
}`,

  normal: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uH;
uniform sampler2D uB0;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform vec2 uTexel;
uniform vec4 uBand;
uniform float uStrength;
uniform float uFlip;
float H(sampler2D t, vec2 d) { return texture(t, vUv + d).r; }
vec2 grad(sampler2D t) {
  vec2 s = uTexel;
  float tl = H(t, vec2(-s.x, s.y));
  float l = H(t, vec2(-s.x, 0.0));
  float bl = H(t, vec2(-s.x, -s.y));
  float tr = H(t, vec2(s.x, s.y));
  float r = H(t, vec2(s.x, 0.0));
  float br = H(t, vec2(s.x, -s.y));
  float tp = H(t, vec2(0.0, s.y));
  float bt = H(t, vec2(0.0, -s.y));
  float gx = (3.0 * tr + 10.0 * r + 3.0 * br) - (3.0 * tl + 10.0 * l + 3.0 * bl);
  float gy = (3.0 * tl + 10.0 * tp + 3.0 * tr) - (3.0 * bl + 10.0 * bt + 3.0 * br);
  return vec2(gx, gy);
}
void main() {
  vec2 g = grad(uB2) * uBand.x + grad(uB1) * uBand.y + grad(uB0) * uBand.z + grad(uH) * uBand.w;
  g *= uStrength * 4.0;
  float flip = uFlip > 0.5 ? -1.0 : 1.0;
  vec3 n = normalize(vec3(-g.x, -g.y * flip, 1.0));
  o = vec4(n * 0.5 + 0.5, 1.0);
}`,

  ao: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uH;
uniform float uDepth;
uniform float uContrast;
void main() {
  float h = texture(uH, vUv).r;
  float c = 0.0;
  for (int i = 1; i <= 4; i++) {
    float r = float(i) * 0.012;
    float around = texture(uH, vUv + vec2(r, 0.0)).r + texture(uH, vUv - vec2(r, 0.0)).r
      + texture(uH, vUv + vec2(0.0, r)).r + texture(uH, vUv - vec2(0.0, r)).r;
    c += max(0.0, around * 0.25 - h);
  }
  float ao = clamp(1.0 - c * uDepth * 1.6, 0.0, 1.0);
  ao = clamp((ao - 0.5) * uContrast + 0.5, 0.0, 1.0);
  o = vec4(vec3(ao), 1.0);
}`,

  rough: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uZones;
uniform sampler2D uAO;
uniform sampler2D uH;
uniform sampler2D uHb;
uniform sampler2D uHf;
uniform sampler2D uAlb;
uniform sampler2D uAb;
uniform sampler2D uNb;
uniform float uLocal;
uniform float uCavity;
uniform float uWear;
uniform float uMicro;
uniform float uSpec;
uniform float uNVar;
uniform float uMin;
uniform float uMax;
uniform float uContrast;
void main() {
  float base = texture(uZones, vUv).r;
  float ao = texture(uAO, vUv).r;
  float h = texture(uH, vUv).r;
  float hb = texture(uHb, vUv).r;
  float cavity = clamp(hb - h, 0.0, 1.0);
  float wear = clamp(h - hb, 0.0, 1.0);
  float micro = abs(h - texture(uHf, vUv).r);
  float nvar = clamp(1.0 - length(texture(uNb, vUv).rgb * 2.0 - 1.0), 0.0, 1.0);
  float spec = texture(uAlb, vUv).a;
  vec3 lw = vec3(0.2126, 0.7152, 0.0722);
  float lb = dot(texture(uAb, vUv).rgb, lw);
  float local = abs(dot(texture(uAlb, vUv).rgb, lw) - lb) / max(lb, 0.02);
  float r = base + cavity * uCavity * (1.0 - ao) - wear * uWear + micro * uMicro - spec * uSpec + nvar * uNVar + local * uLocal;
  r = clamp((r - uMin) / max(0.001, uMax - uMin), 0.0, 1.0);
  r = clamp((r - 0.5) * uContrast + 0.5, 0.0, 1.0);
  o = vec4(vec3(r), 1.0);
}`,

  // Applies a 256-entry table: to the value of a gray map, or to the sRGB luminance of the base color.
  remap: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform float uColor;
${SRGB}
float lut(float v) { return texture(uLut, vec2(clamp(v, 0.0, 1.0) * 255.0 / 256.0 + 0.5 / 256.0, 0.5)).r; }
void main() {
  vec4 c = texture(uTex, vUv);
  if (uColor > 0.5) {
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    float l2 = toLin(vec3(lut(toSRGB(vec3(l)).r))).r;
    o = vec4(l > 1e-5 ? c.rgb * (l2 / l) : vec3(l2), c.a);
    return;
  }
  o = vec4(vec3(lut(c.r)), 1.0);
}`,

  metal: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uZones;
uniform sampler2D uH;
uniform sampler2D uHb;
uniform float uWear;
uniform float uSharp;
void main() {
  float m = texture(uZones, vUv).g;
  float wear = max(0.0, texture(uH, vUv).r - texture(uHb, vUv).r);
  m = clamp(m + smoothstep(0.01, 0.08, wear) * uWear, 0.0, 1.0);
  m = clamp((m - 0.5) * uSharp + 0.5, 0.0, 1.0);
  o = vec4(vec3(m), 1.0);
}`,

  zones: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec4 uZoneColor[6];
uniform vec4 uZoneMat[6];
uniform vec2 uBase;
uniform float uCount;
uniform float uShow;
const vec3 W = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float y = max(dot(c, W), 0.002);
  vec3 chroma = c / max(c.r + c.g + c.b, 0.002);
  vec3 mat = vec3(uBase, 1.0);
  vec3 show = vec3(0.18);
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uCount) break;
    vec3 z = uZoneColor[i].rgb;
    float zy = max(dot(z, W), 0.002);
    vec3 zc = z / max(z.r + z.g + z.b, 0.002);
    float d = length(chroma - zc) * 3.0 + abs(log2(y / zy)) * 0.15;
    float r = uZoneColor[i].a;
    float w = 1.0 - smoothstep(r * 0.5, r, d);
    mat = mix(mat, uZoneMat[i].rgb, w);
    show = mix(show, z, w);
  }
  o = uShow > 0.5 ? vec4(show, 1.0) : vec4(mat, 1.0);
}`,

  nsmooth: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;
vec3 N(vec2 d) { return texture(uTex, vUv + d).rgb * 2.0 - 1.0; }
void main() {
  vec3 c = N(vec2(0.0)) * 0.227027;
  c += (N(uStep) + N(-uStep)) * 0.1945946;
  c += (N(uStep * 2.0) + N(-uStep * 2.0)) * 0.1216216;
  o = vec4(normalize(c) * 0.5 + 0.5, 1.0);
}`,

  opacity: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uH;
uniform sampler2D uHb;
uniform sampler2D uZones;
uniform sampler2D uLoaded;
uniform float uEdge;
uniform float uRagged;
uniform float uPatch;
uniform float uCrack;
uniform float uUseLoaded;
void main() {
  float h = texture(uH, vUv).r;
  float hb = texture(uHb, vUv).r;
  float m = 1.0;
  if (uEdge > 0.001) {
    float edge = min(vUv.x, 1.0 - vUv.x);
    edge += (h - 0.5) * uRagged * uEdge;
    m *= smoothstep(0.0, max(0.001, uEdge), edge);
  }
  if (uPatch > 0.001) {
    float blot = smoothstep(0.02, 0.16, abs(h - hb));
    m *= mix(1.0, blot, clamp(uPatch, 0.0, 1.0));
  }
  if (uCrack > 0.001) {
    float crack = smoothstep(0.01, 0.08, max(0.0, hb - h));
    m *= mix(1.0, crack, clamp(uCrack, 0.0, 1.0));
  }
  m *= texture(uZones, vUv).b;
  if (uUseLoaded > 0.5) m *= texture(uLoaded, vUv).r;
  o = vec4(vec3(clamp(m, 0.0, 1.0)), 1.0);
}`,

  rnm: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uBase;
uniform sampler2D uDetail;
uniform sampler2D uMask;
uniform float uGain;
uniform float uUseMask;
void main() {
  vec3 base = texture(uBase, vUv).rgb;
  vec3 t = texture(uDetail, vUv).rgb * vec3(2.0, 2.0, 2.0) + vec3(-1.0, -1.0, 1.0);
  t.xy *= uGain;
  vec3 u = base * vec3(-2.0, -2.0, 2.0) + vec3(1.0, 1.0, -1.0);
  vec3 r = normalize(t * dot(t, u) - u * t.z);
  float mask = uUseMask > 0.5 ? texture(uMask, vUv).r : 1.0;
  o = vec4(mix(base, r * 0.5 + 0.5, mask), 1.0);
}`,

  addHP: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uBase;
uniform sampler2D uGen;
uniform sampler2D uB0;
uniform sampler2D uB1;
uniform sampler2D uB2;
uniform float uGain;
uniform float uSize;
void main() {
  float s = clamp(uSize, 0.0, 1.0) * 2.0;
  // each blur pass keeps 0.8595 of the brightness; levels have had 2, 4 and 6 passes
  float b0 = texture(uB0, vUv).r / 0.7387;
  float b1 = texture(uB1, vUv).r / 0.5457;
  float b2 = texture(uB2, vUv).r / 0.4031;
  float blur = s < 1.0 ? mix(b0, b1, s) : mix(b1, b2, s - 1.0);
  float v = texture(uBase, vUv).r + (texture(uGen, vUv).r - blur) * uGain;
  o = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
}`,

  flatMask: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uBase;
uniform sampler2D uBlur;
uniform float uAmount;
void main() {
  vec3 a = texture(uBase, vUv).rgb * 2.0 - 1.0;
  vec3 b = texture(uBlur, vUv).rgb * 2.0 - 1.0;
  float detail = clamp(length(a.xy - b.xy) * 4.0, 0.0, 1.0);
  float keep = mix(1.0, 1.0 - detail, uAmount);
  o = vec4(vec3(keep), 1.0);
}`,
};
