const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vUv = p;
}`;

const EQUIRECT = `const float PI = 3.14159265;
vec3 dirOf(vec2 uv) {
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float theta = (uv.y - 0.5) * PI;
  return vec3(sin(phi) * cos(theta), sin(theta), cos(phi) * cos(theta));
}
vec2 uvOf(vec3 d) {
  return vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, clamp(asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5, 0.002, 0.998));
}`;

const TONEMAP = `vec3 toSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
// GT7 SDR tonemap
// Input is frame-buffer scale (1.0 = 100 nits), paper white 250 nits.
const mat3 TO_2020 = mat3(0.627404, 0.069097, 0.0163916, 0.329282, 0.919541, 0.0880132, 0.0433136, 0.0113612, 0.895595);
const mat3 TO_709 = mat3(1.660496, -0.124547, -0.018154, -0.587656, 1.1329, -0.100597, -0.07284, -0.008352, 1.118751);
float linToPq(float v) {
  float ym = pow(max(v, 0.0) / 100.0, 0.1593017578125);
  return exp2(78.84375 * (log2(0.8359375 + 18.8515625 * ym) - log2(1.0 + 18.6875 * ym)));
}
float pqToLin(float n) {
  float np = pow(clamp(n, 0.0, 1.0), 1.0 / 78.84375);
  float l = max(np - 0.8359375, 0.0) / (18.8515625 - 18.6875 * np);
  return pow(l, 1.0 / 0.1593017578125) * 100.0;
}
vec3 toIctcp(vec3 c) {
  vec3 lms = vec3(dot(c, vec3(1688.0, 2146.0, 262.0)), dot(c, vec3(683.0, 2951.0, 462.0)), dot(c, vec3(99.0, 309.0, 3688.0))) / 4096.0;
  vec3 p = vec3(linToPq(lms.x), linToPq(lms.y), linToPq(lms.z));
  return vec3(0.5 * (p.x + p.y), dot(p, vec3(6610.0, -13613.0, 7003.0)) / 4096.0, dot(p, vec3(17933.0, -17390.0, -543.0)) / 4096.0);
}
vec3 fromIctcp(vec3 i) {
  vec3 lms = vec3(
    pqToLin(i.x + 0.00860904 * i.y + 0.11103 * i.z),
    pqToLin(i.x - 0.00860904 * i.y - 0.11103 * i.z),
    pqToLin(i.x + 0.560031 * i.y - 0.320627 * i.z));
  return max(vec3(
    dot(lms, vec3(3.43661, -2.50645, 0.0698454)),
    dot(lms, vec3(-0.79133, 1.9836, -0.192271)),
    dot(lms, vec3(-0.0259499, -0.0989137, 1.12486))), 0.0);
}
float gtCurve(float x) {
  if (x <= 0.0) return 0.0;
  if (x >= 1.11) return 2.9633333 - 3.3733512 * exp(-0.5395683 * x);
  return mix(0.538 * pow(x / 0.538, 1.28), x, smoothstep(0.0, 0.538, x));
}
vec3 tonemap(vec3 c709) {
  vec3 c = max(TO_2020 * c709, 0.0);
  vec3 ucs = toIctcp(c);
  vec3 skewed = vec3(gtCurve(c.r), gtCurve(c.g), gtCurve(c.b));
  float chroma = 1.0 - smoothstep(0.98, 1.16, ucs.x / 0.6025592);
  vec3 scaled = fromIctcp(vec3(toIctcp(skewed).x, ucs.yz * chroma));
  return TO_709 * (min(mix(skewed, scaled, 0.6), 2.5) / 2.5);
}`;

const ATMOSPHERE = `const float RE = 6371e3;
const float RA = 6471e3;
const vec3 BR = vec3(5.5e-6, 13.0e-6, 22.4e-6);
const float BM = 21e-6;
const float HR = 8e3;
const float HM = 1.2e3;
const float MIE_G = 0.758;
const float SUN = 22.0;
const vec3 GROUND = vec3(0.16, 0.15, 0.13);
vec2 rsi(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float h = b * b - (dot(o, o) - r * r);
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
bool scatter(vec3 d, vec3 s, out vec3 col, out vec3 trans) {
  vec3 o = vec3(0.0, RE + 2.0, 0.0);
  float tEnd = rsi(o, d, RA).y;
  float g = rsi(o, d, RE).x;
  bool ground = g > 0.0;
  if (ground) tEnd = g;
  float ds = tEnd / 16.0;
  float mu = dot(d, s);
  float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float gg = MIE_G * MIE_G;
  float pm = 3.0 / (8.0 * PI) * ((1.0 - gg) * (1.0 + mu * mu)) / ((2.0 + gg) * pow(1.0 + gg - 2.0 * MIE_G * mu, 1.5));
  float odR = 0.0;
  float odM = 0.0;
  vec3 totR = vec3(0.0);
  vec3 totM = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    vec3 p = o + d * (ds * (float(i) + 0.5));
    float h = length(p) - RE;
    float hr = exp(-h / HR) * ds;
    float hm = exp(-h / HM) * ds;
    odR += hr;
    odM += hm;
    if (rsi(p, s, RE).x > 0.0) continue;
    float dl = rsi(p, s, RA).y / 8.0;
    float lr = 0.0;
    float lm = 0.0;
    for (int j = 0; j < 8; j++) {
      vec3 q = p + s * (dl * (float(j) + 0.5));
      float hl = length(q) - RE;
      lr += exp(-hl / HR) * dl;
      lm += exp(-hl / HM) * dl;
    }
    vec3 att = exp(-(BM * (odM + lm) + BR * (odR + lr)));
    totR += hr * att;
    totM += hm * att;
  }
  col = SUN * (pr * BR * totR + pm * BM * totM);
  trans = exp(-(BR * odR + BM * odM));
  return ground;
}`;

const HAMMERSLEY = `vec2 hammersley(uint i, uint n) {
  uint b = i;
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return vec2(float(i) / float(n), float(b) * 2.3283064365386963e-10);
}`;

const FS = {
  linear: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
vec3 toLin(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
void main() { o = vec4(toLin(texture(uTex, vUv).rgb), texture(uTex, vUv).a); }`,

  copy: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uFlip;
void main() {
  vec4 c = texture(uTex, vUv);
  if (uFlip > 0.5) c.g = 1.0 - c.g;
  o = c;
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

  delight: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform float uStrength;
uniform float uHighlight;
uniform vec3 uWhite;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 blur = texture(uBlur, vUv).rgb;
  float sumS = max(src.r + src.g + src.b, 0.0001);
  float sumB = max(blur.r + blur.g + blur.b, 0.0001);
  float cd = distance(src / sumS, blur / sumB);
  float w = uStrength * (1.0 - smoothstep(0.04, 0.22, cd));
  float y = max(luma(src), 0.0001);
  float yb = max(luma(blur), 0.0001);
  vec3 alb = src * pow(0.5 / yb, w);
  float mx = max(src.r, max(src.g, src.b));
  float mn = min(src.r, min(src.g, src.b));
  float sat = mx <= 0.0001 ? 0.0 : (mx - mn) / mx;
  float hi = smoothstep(0.04, 0.28, y - yb) * (1.0 - sat);
  alb = mix(alb, (blur / sumB) * yb, hi * uHighlight);
  alb *= uWhite;
  alb = clamp(alb, 0.0, 4.0);
  o = vec4(alb, hi);
}`,

  norm: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uScale;
void main() {
  vec4 c = texture(uTex, vUv);
  o = vec4(clamp(c.rgb * uScale, 0.03, 0.90), c.a);
}`,

  relief: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uAlb;
uniform sampler2D uN;
uniform vec3 uLight;
uniform float uStrength;
void main() {
  vec4 alb = texture(uAlb, vUv);
  vec3 n = texture(uN, vUv).rgb * 2.0 - 1.0;
  float shade = clamp(dot(normalize(n), normalize(uLight)), 0.15, 1.0);
  vec3 c = alb.rgb / mix(1.0, shade, uStrength);
  o = vec4(clamp(c, 0.03, 0.90), alb.a);
}`,

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
uniform sampler2D uRegion;
uniform sampler2D uAO;
uniform sampler2D uH;
uniform sampler2D uHb;
uniform sampler2D uHf;
uniform sampler2D uAlb;
uniform sampler2D uNb;
uniform float uCavity;
uniform float uWear;
uniform float uMicro;
uniform float uSpec;
uniform float uNVar;
uniform float uMin;
uniform float uMax;
uniform float uContrast;
void main() {
  float base = texture(uRegion, vUv).r;
  float ao = texture(uAO, vUv).r;
  float h = texture(uH, vUv).r;
  float hb = texture(uHb, vUv).r;
  float cavity = clamp(hb - h, 0.0, 1.0);
  float wear = clamp(h - hb, 0.0, 1.0);
  float micro = abs(h - texture(uHf, vUv).r);
  float nvar = clamp(1.0 - length(texture(uNb, vUv).rgb * 2.0 - 1.0), 0.0, 1.0);
  float spec = texture(uAlb, vUv).a;
  float r = base + cavity * uCavity * (1.0 - ao) - wear * uWear + micro * uMicro - spec * uSpec + nvar * uNVar;
  r = clamp((r - uMin) / max(0.001, uMax - uMin), 0.0, 1.0);
  r = clamp((r - 0.5) * uContrast + 0.5, 0.0, 1.0);
  o = vec4(vec3(r), 1.0);
}`,

  metal: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uRegion;
uniform sampler2D uH;
uniform sampler2D uHb;
uniform float uWear;
uniform float uSharp;
void main() {
  float m = texture(uRegion, vUv).g;
  float wear = max(0.0, texture(uH, vUv).r - texture(uHb, vUv).r);
  m = clamp(m + smoothstep(0.01, 0.08, wear) * uWear, 0.0, 1.0);
  m = clamp((m - 0.5) * uSharp + 0.5, 0.0, 1.0);
  o = vec4(vec3(m), 1.0);
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
uniform sampler2D uRegion;
uniform sampler2D uLoaded;
uniform float uEdge;
uniform float uRagged;
uniform float uPatch;
uniform float uCrack;
uniform float uRegionPick;
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
  if (uRegionPick >= 0.0) {
    float id = texture(uRegion, vUv).b * 255.0;
    m *= 1.0 - smoothstep(0.4, 0.6, abs(id - uRegionPick));
  }
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
vec3 toSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
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

  sky: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec3 uSun;
uniform vec3 uSunColor;
${EQUIRECT}
${ATMOSPHERE}
void main() {
  vec3 d = dirOf(vUv);
  vec3 col = vec3(0.0);
  vec3 trans = vec3(1.0);
  bool ground = scatter(d, uSun, col, trans);
  if (ground) col += trans * GROUND / PI * uSunColor * max(uSun.y, 0.0) * 1.3;
  o = vec4(col, 1.0);
}`,

  prefilter: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uEnv;
uniform vec2 uEnvSize;
uniform float uRough;
${EQUIRECT}
${HAMMERSLEY}
void main() {
  vec3 N = dirOf(vUv);
  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float a = uRough * uRough;
  float a2 = a * a;
  float texel = 4.0 * PI / (uEnvSize.x * uEnvSize.y);
  vec3 sum = vec3(0.0);
  float w = 0.0;
  for (int i = 0; i < 64; i++) {
    vec2 xi = hammersley(uint(i), 64u);
    float phi = 2.0 * PI * xi.x;
    float ct = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    float st = sqrt(1.0 - ct * ct);
    vec3 H = T * (cos(phi) * st) + B * (sin(phi) * st) + N * ct;
    vec3 L = 2.0 * dot(N, H) * H - N;
    float nl = dot(N, L);
    if (nl <= 0.0) continue;
    float dd = ct * ct * (a2 - 1.0) + 1.0;
    float pdf = a2 / (PI * dd * dd) * 0.25;
    float lod = max(0.0, 0.5 * log2(1.0 / (64.0 * pdf * texel)) + 1.0);
    sum += textureLod(uEnv, uvOf(L), lod).rgb * nl;
    w += nl;
  }
  o = vec4(sum / max(w, 1e-4), 1.0);
}`,

  irradiance: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uEnv;
uniform vec2 uEnvSize;
${EQUIRECT}
${HAMMERSLEY}
void main() {
  vec3 N = dirOf(vUv);
  vec3 up = abs(N.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  float texel = 4.0 * PI / (uEnvSize.x * uEnvSize.y);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 128; i++) {
    vec2 xi = hammersley(uint(i), 128u);
    float phi = 2.0 * PI * xi.x;
    float ct = sqrt(1.0 - xi.y);
    float st = sqrt(xi.y);
    vec3 L = T * (cos(phi) * st) + B * (sin(phi) * st) + N * ct;
    float lod = max(0.0, 0.5 * log2(PI / (128.0 * max(ct, 0.02) * texel)) + 1.0);
    sum += textureLod(uEnv, uvOf(L), lod).rgb;
  }
  o = vec4(sum / 128.0, 1.0);
}`,

  preview: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uAlb;
uniform sampler2D uN;
uniform sampler2D uR;
uniform sampler2D uM;
uniform sampler2D uAO;
uniform sampler2D uOp;
uniform sampler2D uEnv0;
uniform sampler2D uEnv1;
uniform sampler2D uEnv2;
uniform sampler2D uEnv3;
uniform sampler2D uEnv4;
uniform sampler2D uIrr;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec2 uRes;
uniform vec2 uView;
uniform mat3 uRot;
uniform float uRepeatX;
uniform float uRepeatY;
uniform float uShape;
uniform float uSeam;
uniform float uZoom;
uniform vec2 uCenter;
uniform float uSS;
uniform float uDirect;
uniform vec4 uFactor;
uniform vec3 uTint;
const float FOCAL = 3.0;
${EQUIRECT}
${TONEMAP}
// Exposure for a mid grey ground. The frame is metered afterwards and scaled so the material averages 0.7.
float autoExposure() {
  vec3 sky = textureLod(uIrr, uvOf(vec3(0.0, 1.0, 0.0)), 0.0).rgb;
  vec3 grey = 0.18 * (uSunColor * max(uSun.y, 0.0) / PI + sky);
  return 0.7 / max(dot(grey, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
}
vec3 envLevel(float i, vec2 uv) {
  if (i < 0.5) return textureLod(uEnv0, uv, 0.0).rgb;
  if (i < 1.5) return textureLod(uEnv1, uv, 0.0).rgb;
  if (i < 2.5) return textureLod(uEnv2, uv, 0.0).rgb;
  if (i < 3.5) return textureLod(uEnv3, uv, 0.0).rgb;
  return textureLod(uEnv4, uv, 0.0).rgb;
}
vec3 specEnv(vec3 d, float rough) {
  vec2 uv = uvOf(d);
  float f = clamp(rough, 0.0, 1.0) * 4.0;
  float i = floor(f);
  return mix(envLevel(i, uv), envLevel(min(i + 1.0, 4.0), uv), f - i);
}
vec2 envAB(float rough, float ndv) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a + r.zw;
}
struct Hit {
  bool ok;
  float t;
  vec3 N;
  vec3 T;
  vec3 B;
  vec2 uv;
  vec2 tw;
};
Hit trace(vec3 ro, vec3 rd) {
  Hit h;
  h.ok = false;
  h.t = 0.0;
  h.N = vec3(0.0, 0.0, 1.0);
  h.T = vec3(1.0, 0.0, 0.0);
  h.B = vec3(0.0, 1.0, 0.0);
  h.uv = vec2(0.0);
  h.tw = vec2(1.0);
  float a = uRes.x / uRes.y;
  vec2 rep = vec2(max(uRepeatX, 1.0), max(uRepeatY, 1.0));
  if (uShape < 0.5) {
    if (abs(rd.z) < 1e-5) return h;
    float t = -ro.z / rd.z;
    if (t < 0.0) return h;
    vec3 P = ro + t * rd;
    vec2 span = vec2(a, 1.0) * rep;
    if (abs(P.x) > span.x * 0.5 || abs(P.y) > span.y * 0.5) return h;
    h.ok = true;
    h.t = t;
    h.N = vec3(0.0, 0.0, rd.z < 0.0 ? 1.0 : -1.0);
    h.uv = vec2(P.x / span.x + 0.5, P.y / span.y + 0.5);
    h.tw = vec2(a, 1.0) / uRes;
  } else if (uShape < 1.5) {
    float r = 0.5 * min(1.0, a);
    float b = dot(ro, rd);
    float disc = b * b - (dot(ro, ro) - r * r);
    if (disc < 0.0) return h;
    float t = -b - sqrt(disc);
    if (t < 0.0) return h;
    vec3 N = normalize(ro + t * rd);
    h.ok = true;
    h.t = t;
    h.N = N;
    h.T = normalize(vec3(N.z, 0.0, -N.x) + vec3(1e-5, 0.0, 0.0));
    h.B = cross(N, h.T);
    h.uv = vec2(atan(N.x, N.z) / PI + 0.5, asin(clamp(N.y, -1.0, 1.0)) / PI + 0.5);
    h.tw = vec2(max(sqrt(1.0 - N.y * N.y), 0.05), 1.0) * PI * r / (rep * uRes);
  } else {
    const float hs = 0.26;
    vec3 inv = 1.0 / rd;
    vec3 t0 = (-hs - ro) * inv;
    vec3 t1 = (hs - ro) * inv;
    vec3 lo = min(t0, t1);
    vec3 hi = max(t0, t1);
    float tn = max(lo.x, max(lo.y, lo.z));
    float tf = min(hi.x, min(hi.y, hi.z));
    if (tn > tf || tf < 0.0) return h;
    vec3 N;
    if (lo.x >= lo.y && lo.x >= lo.z) N = vec3(-sign(rd.x), 0.0, 0.0);
    else if (lo.y >= lo.z) N = vec3(0.0, -sign(rd.y), 0.0);
    else N = vec3(0.0, 0.0, -sign(rd.z));
    vec3 T = vec3(1.0, 0.0, 0.0);
    vec3 B = vec3(0.0, 1.0, 0.0);
    if (abs(N.z) > 0.5) T = vec3(N.z, 0.0, 0.0);
    else if (abs(N.x) > 0.5) T = vec3(0.0, 0.0, -N.x);
    else B = vec3(0.0, 0.0, -N.y);
    vec3 P = ro + tn * rd;
    h.ok = true;
    h.t = tn;
    h.N = N;
    h.T = T;
    h.B = B;
    h.uv = vec2(dot(P, T), dot(P, B)) / (2.0 * hs) + 0.5;
    h.tw = vec2(2.0 * hs) / (rep * uRes);
  }
  return h;
}
vec4 scene(vec2 s) {
  float texA = uRes.x / max(uRes.y, 1.0);
  float viewA = uView.x / max(uView.y, 1.0);
  vec2 rep = vec2(max(uRepeatX, 1.0), max(uRepeatY, 1.0));
  float gridA = texA * rep.x / rep.y;
  float fit = max(rep.y, gridA / viewA);
  vec3 rd = normalize(vec3(s.x * viewA * fit, s.y * fit, -FOCAL));
  vec3 ro = vec3(0.0, 0.0, FOCAL);
  Hit h = trace(ro * uRot, rd * uRot);
  float exposure = autoExposure();
  if (!h.ok) {
    vec3 sky = envLevel(0.0, uvOf(rd));
    sky += uSunColor * 400.0 * smoothstep(0.99996, 0.99999, dot(rd, uSun));
    return vec4(sky * exposure, 0.0);
  }
  vec3 Ng = uRot * h.N;
  vec3 T = uRot * h.T;
  vec3 B = uRot * h.B;
  vec3 V = -rd;
  float ndvg = abs(dot(Ng, V));
  float footprint = h.t * fit / (max(uZoom, 0.05) * uView.y * FOCAL);
  float lod = max(0.0, log2(footprint * inversesqrt(max(ndvg, 0.05)) / min(h.tw.x, h.tw.y)) - uSS);
  vec2 uv = h.uv * vec2(uRepeatX, uRepeatY);
  vec3 alb = textureLod(uAlb, uv, lod).rgb * uTint;
  vec3 tn = textureLod(uN, uv, lod).rgb * 2.0 - 1.0;
  // The game multiplies the maps by the material factors: roughness, metallic, opacity, normal strength (xy).
  float rough = textureLod(uR, uv, lod).r * uFactor.x;
  float metal = textureLod(uM, uv, lod).r * uFactor.y;
  float ao = textureLod(uAO, uv, lod).r;
  float op = textureLod(uOp, uv, lod).r * uFactor.z;
  float len = max(length(tn), 0.1);
  tn /= len;
  tn = normalize(vec3(tn.xy * uFactor.w, tn.z));
  rough = clamp(sqrt(rough * rough + 0.5 * (1.0 - len) / len), 0.02, 1.0);
  vec3 n = normalize(T * tn.x + B * tn.y + Ng * tn.z);
  float ndv = max(dot(n, V), 1e-3);
  vec3 f0 = mix(vec3(0.04), alb, metal);
  vec2 ab = envAB(rough, ndv);
  vec3 fss = f0 * ab.x + ab.y;

  vec3 L = uSun;
  vec3 H = normalize(L + V);
  float ndl = max(dot(n, L), 0.0);
  float ndh = max(dot(n, H), 0.0);
  float vdh = max(dot(V, H), 0.0);
  float a = max(rough, 0.05);
  a *= a;
  float a2 = a * a;
  float dd = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float gv = ndl * sqrt(ndv * ndv * (1.0 - a2) + a2);
  float g2 = ndv * sqrt(ndl * ndl * (1.0 - a2) + a2);
  float vis = 0.5 / max(gv + g2, 1e-5);
  vec3 fr = f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0);
  float lit = smoothstep(0.0, 0.05, dot(Ng, L));
  vec3 E = uSunColor * lit * ndl;
  vec3 spec = D * vis * fr * E;

  vec3 R = reflect(-V, n);
  float horizon = clamp(1.0 + 1.3 * dot(R, Ng), 0.0, 1.0);
  vec3 refl = specEnv(R, rough) * fss * ao * horizon * horizon;
  vec3 irr = textureLod(uIrr, uvOf(n), 0.0).rgb;
  // Disney / Burley diffuse for the sun, the ambient term stays Lambert.
  float f90 = 0.5 + 2.0 * rough * vdh * vdh;
  float burley = (1.0 + (f90 - 1.0) * pow(1.0 - ndl, 5.0)) * (1.0 + (f90 - 1.0) * pow(1.0 - ndv, 5.0));
  vec3 diffuse = alb * (1.0 - metal) * (E * burley / PI + irr * ao);

  // Exposed HDR, the checker and seam colours are picked to land at their old display values.
  vec3 col = (diffuse + spec + refl) * exposure;
  vec3 checker = mod(floor(gl_FragCoord.x / 12.0) + floor(gl_FragCoord.y / 12.0), 2.0) < 0.5 ? vec3(0.085) : vec3(0.2);
  col = mix(checker, col, op);
  if (uSeam > 0.5 && uShape < 0.5) {
    vec2 f = fract(uv);
    if (min(f.x, f.y) < 0.012 / max(uZoom, 1.0)) col = mix(col, vec3(1.9, 0.7, 0.26), 0.75);
  }
  return vec4(col, 1.0);
}
void main() {
  float zoom = max(uZoom, 0.05);
  vec2 dx = dFdx(vUv);
  vec2 dy = dFdy(vUv);
  vec2 offs[4] = vec2[4](vec2(0.125, 0.375), vec2(0.375, -0.125), vec2(-0.125, -0.375), vec2(-0.375, 0.125));
  float count = uSS > 0.5 ? 4.0 : 1.0;
  vec3 acc = vec3(0.0);
  float cover = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= count) break;
    vec2 off = uSS > 0.5 ? offs[i] : vec2(0.0);
    vec2 p = vUv + off.x * dx + off.y * dy;
    vec4 s = scene((p - 0.5) / zoom + uCenter - 0.5);
    acc += s.rgb;
    cover += s.a;
  }
  vec3 hdr = min(acc / count, vec3(60000.0));
  o = uDirect > 0.5 ? vec4(toSRGB(tonemap(hdr)), 1.0) : vec4(hdr, cover / count);
}`,

  // Karis average + quadratic threshold on the first downsample, 13 tap downsample after, tent upsample added back with blending.
  bloomDown: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uExposure;
vec3 tap(vec2 d) {
  vec3 c = textureLod(uTex, vUv + d * uTexel, 0.0).rgb;
  return uFirst > 0.5 ? c * uExposure : c;
}
float wKaris(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main() {
  if (uFirst > 0.5) {
    vec3 a = tap(vec2(-1.0, -1.0));
    vec3 b = tap(vec2(1.0, -1.0));
    vec3 c = tap(vec2(-1.0, 1.0));
    vec3 d = tap(vec2(1.0, 1.0));
    float wa = wKaris(a), wb = wKaris(b), wc = wKaris(c), wd = wKaris(d);
    vec3 avg = min((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), vec3(50.0));
    const float th = 2.0;
    const float knee = 0.1;
    float bright = max(avg.r, max(avg.g, avg.b));
    float rq = clamp(bright - (th - knee), 0.0, 2.0 * knee);
    o = vec4(avg * max(0.25 / knee * rq * rq, bright - th) / max(bright, 0.001), 1.0);
    return;
  }
  vec3 inner = tap(vec2(-0.5, -0.5)) + tap(vec2(0.5, -0.5)) + tap(vec2(-0.5, 0.5)) + tap(vec2(0.5, 0.5));
  vec3 A = tap(vec2(-1.0, -1.0)), B = tap(vec2(0.0, -1.0)), C = tap(vec2(1.0, -1.0));
  vec3 F = tap(vec2(-1.0, 0.0)), G = tap(vec2(0.0)), H = tap(vec2(1.0, 0.0));
  vec3 K = tap(vec2(-1.0, 1.0)), L = tap(vec2(0.0, 1.0)), M = tap(vec2(1.0, 1.0));
  vec3 outer = (A + B + G + F) + (B + C + H + G) + (F + G + L + K) + (G + H + M + L);
  o = vec4(inner * 0.125 + outer * 0.03125, 1.0);
}`,

  bloomUp: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uWeight;
vec3 tap(vec2 d) { return textureLod(uTex, vUv + d * uTexel, 0.0).rgb; }
void main() {
  vec3 s = tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0));
  s += 2.0 * (tap(vec2(0.0, -1.0)) + tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, 1.0)));
  s += 4.0 * tap(vec2(0.0));
  o = vec4(s / 16.0 * uWeight, 1.0);
}`,

  litFinal: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uBloomScale;
uniform float uExposure;
${TONEMAP}
void main() {
  vec3 c = textureLod(uHdr, vUv, 0.0).rgb * uExposure + uBloomScale * textureLod(uBloom, vUv, 0.0).rgb;
  o = vec4(toSRGB(tonemap(c)), 1.0);
}`,

  // One mip texel of the lit frame as log2 luminance (-12..12) packed into 16 bits, plus coverage (sky is alpha 0, material is 1).
  meter: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uLod;
void main() {
  vec4 c = textureLod(uTex, vUv, uLod);
  float y = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float v = floor(clamp((log2(max(y, 1e-6)) + 12.0) / 24.0, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(v / 256.0);
  o = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, c.a, 1.0);
}`,
};

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader');
  }
  return shader;
}

function program(gl, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || 'link');
  }
  return prog;
}

const PREVIEW_SHAPES = { plane: 0, sphere: 1, cube: 2 };
const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function sunDirection(light) {
  const x = light[0];
  const z = 0.65;
  const y = Math.max(light[1], 0.03 * Math.hypot(x, z));
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

function sunColor(dir) {
  const RE = 6371e3;
  const RA = 6471e3;
  const oy = RE + 2;
  const b = oy * dir[1];
  const t = -b + Math.sqrt(b * b - (oy * oy - RA * RA));
  const ds = t / 32;
  let odR = 0;
  let odM = 0;
  for (let i = 0; i < 32; i++) {
    const s = ds * (i + 0.5);
    const h = Math.hypot(dir[0] * s, oy + dir[1] * s, dir[2] * s) - RE;
    odR += Math.exp(-h / 8e3) * ds;
    odM += Math.exp(-h / 1.2e3) * ds;
  }
  return [5.5e-6, 13.0e-6, 22.4e-6].map((br) => 22 * Math.exp(-(br * odR + 21e-6 * odM)));
}

export const CLASSES = {
  asphalt: { rough: 0.85, metal: 0 },
  concrete: { rough: 0.72, metal: 0 },
  paint: { rough: 0.35, metal: 0 },
  bareMetal: { rough: 0.22, metal: 1 },
  rubber: { rough: 0.92, metal: 0 },
  fabric: { rough: 0.95, metal: 0 },
  dirt: { rough: 0.9, metal: 0 },
  wood: { rough: 0.55, metal: 0 },
};

export function createEngine(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is required');
  const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const progs = {};
  Object.keys(FS).forEach((name) => { progs[name] = program(gl, FS[name]); });

  const rts = new Map();
  let width = 0;
  let height = 0;
  let screenW = 0;
  let screenH = 0;
  let sourceTex = null;
  const loaded = {};
  let maskTex = null;
  let labels = null;
  let labelKey = '';
  let labelW = 0;
  let labelH = 0;
  const warnings = [];
  const finals = {};
  const mipped = new Set();
  const used = new Set();
  let skyKey = '';
  let skyUp = [0, 0, 0];
  let shownScale = null;
  let exposureTime = 0;
  let adaptQueued = false;
  let liveParams = null;
  let factors = { roughness: 1, metallic: 1, opacity: 1, normal: 1 };
  let tint = [1, 1, 1];

  let wrapS = gl.CLAMP_TO_EDGE;
  let wrapT = gl.CLAMP_TO_EDGE;

  function rt(name, w, h, float) {
    const wantFloat = !!float && floatOk;
    used.add(name);
    const prev = rts.get(name);
    if (prev && prev.w === w && prev.h === h && prev.float === wantFloat) return prev;
    if (prev) {
      gl.deleteTexture(prev.tex);
      gl.deleteFramebuffer(prev.fb);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (wantFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    if (gl.getError() === gl.OUT_OF_MEMORY || gl.isContextLost()) {
      gl.deleteTexture(tex);
      rts.delete(name);
      throw new Error('gpu-oom');
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const made = { tex, fb, w, h, float: wantFloat };
    rts.set(name, made);
    return made;
  }

  function draw(name, out, textures, uniforms) {
    const prog = progs[name];
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, out ? out.w : screenW, out ? out.h : screenH);
    let unit = 0;
    Object.keys(textures || {}).forEach((key) => {
      const tex = textures[key].tex || textures[key];
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
      const loc = gl.getUniformLocation(prog, key);
      if (loc) gl.uniform1i(loc, unit);
      unit += 1;
    });
    Object.keys(uniforms || {}).forEach((key) => {
      const loc = gl.getUniformLocation(prog, key);
      if (!loc) return;
      const val = uniforms[key];
      if (typeof val === 'number') gl.uniform1f(loc, val);
      else if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
      else if (val.length === 3) gl.uniform3f(loc, val[0], val[1], val[2]);
      else if (val.length === 9) gl.uniformMatrix3fv(loc, false, val);
      else gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function uploadImage(image) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (gl.getError() === gl.OUT_OF_MEMORY || gl.isContextLost()) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.deleteTexture(tex);
      throw new Error('gpu-oom');
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return tex;
  }

  function read(target) {
    if (target.float) {
      const bytes = rt('tmpB', target.w, target.h);
      draw('copy', bytes, { uTex: target }, { uFlip: 0 });
      target = bytes;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    const buf = new Uint8Array(target.w * target.h * 4);
    gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8Array(buf.length);
    const row = target.w * 4;
    for (let y = 0; y < target.h; y++) {
      out.set(buf.subarray(y * row, y * row + row), (target.h - 1 - y) * row);
    }
    return out;
  }

  function meanOf(target) {
    const small = rt('mean', 16, 16);
    draw('copy', small, { uTex: target }, { uFlip: 0 });
    const buf = read(small);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++; }
    return [r / n / 255, g / n / 255, b / n / 255];
  }

  // Pyramids and the tmp targets share names wherever their contents are dead, to save GPU memory.
  function blurPyramid(src, prefix) {
    let current = src;
    const levels = [];
    for (let i = 0; i < 4; i++) {
      const step = Math.pow(2, i);
      const horiz = rt('blurTmp', width, height, true);
      const vert = rt(prefix + 'v' + i, width, height, true);
      draw('blur', horiz, { uTex: current }, { uStep: [step / width, 0] });
      draw('blur', vert, { uTex: horiz }, { uStep: [0, step / height] });
      levels.push(vert);
      current = vert;
    }
    return levels;
  }

  // Same blur as the last pyramid level, in 8 bit, ping-ponging between tmpB and blur8.
  function blurCoarse(src) {
    let current = src;
    const horiz = rt('blur8', width, height);
    const vert = rt('tmpB', width, height);
    for (let i = 0; i < 4; i++) {
      const step = Math.pow(2, i);
      draw('blur', horiz, { uTex: current }, { uStep: [step / width, 0] });
      draw('blur', vert, { uTex: horiz }, { uStep: [0, step / height] });
      current = vert;
    }
    return vert;
  }

  function cluster(albedo, height, k) {
    const aw = 48;
    const ah = 48;
    const aSmall = rt('as', aw, ah);
    const hSmall = rt('hs', aw, ah);
    draw('copy', aSmall, { uTex: albedo }, { uFlip: 0 });
    draw('copy', hSmall, { uTex: height }, { uFlip: 0 });
    const aBuf = read(aSmall);
    const hBuf = read(hSmall);
    const points = [];
    for (let i = 0; i < aw * ah; i++) {
      points.push([aBuf[i * 4] / 255, aBuf[i * 4 + 1] / 255, aBuf[i * 4 + 2] / 255, hBuf[i * 4] / 255]);
    }
    const centers = [];
    for (let i = 0; i < k; i++) centers.push(points[Math.floor((i + 0.5) * points.length / k)].slice());
    const ids = new Uint8Array(points.length);
    for (let iter = 0; iter < 6; iter++) {
      const acc = Array.from({ length: k }, () => [0, 0, 0, 0, 0]);
      for (let i = 0; i < points.length; i++) {
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < k; c++) {
          let d = 0;
          for (let n = 0; n < 4; n++) {
            const diff = points[i][n] - centers[c][n];
            d += diff * diff * (n === 3 ? 0.35 : 1);
          }
          if (d < bestD) { bestD = d; best = c; }
        }
        ids[i] = best;
        for (let n = 0; n < 4; n++) acc[best][n] += points[i][n];
        acc[best][4] += 1;
      }
      for (let c = 0; c < k; c++) {
        if (!acc[c][4]) continue;
        for (let n = 0; n < 4; n++) centers[c][n] = acc[c][n] / acc[c][4];
      }
    }
    labels = ids;
    labelW = aw;
    labelH = ah;
  }

  function writeRegion(k, classes, metals) {
    const data = new Uint8Array(labelW * labelH * 4);
    for (let i = 0; i < labels.length; i++) {
      const id = Math.min(k - 1, labels[i]);
      const info = CLASSES[classes[id]] || CLASSES.asphalt;
      const metal = Number.isFinite(metals[id]) ? metals[id] : info.metal;
      data[i * 4] = Math.round(info.rough * 255);
      data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, metal)) * 255);
      data[i * 4 + 2] = id;
      data[i * 4 + 3] = 255;
    }
    const dest = rt('region', labelW, labelH);
    gl.bindTexture(gl.TEXTURE_2D, dest.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, labelW, labelH, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return dest;
  }

  function fitLight(albedo, normal) {
    const n = 24;
    const a = rt('fa', n, n);
    const b = rt('fn', n, n);
    draw('copy', a, { uTex: albedo }, { uFlip: 0 });
    draw('copy', b, { uTex: normal }, { uFlip: 0 });
    const ab = read(a);
    const nb = read(b);
    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
    for (let i = 0; i < n * n; i++) {
      const y = (0.2126 * ab[i * 4] + 0.7152 * ab[i * 4 + 1] + 0.0722 * ab[i * 4 + 2]) / 255;
      const nx = nb[i * 4] / 255 * 2 - 1;
      const ny = nb[i * 4 + 1] / 255 * 2 - 1;
      a00 += nx * nx; a01 += nx * ny; a11 += ny * ny;
      b0 += nx * y; b1 += ny * y;
    }
    const det = a00 * a11 - a01 * a01 || 1e-5;
    const lx = (b0 * a11 - b1 * a01) / det;
    const ly = (b1 * a00 - b0 * a01) / det;
    const len = Math.hypot(lx, ly, 0.6) || 1;
    return [lx / len, ly / len, 0.6 / len];
  }

  function setSource(image) {
    if (sourceTex) gl.deleteTexture(sourceTex);
    sourceTex = image ? uploadImage(image) : null;
    labels = null;
  }

  function setLoaded(name, image) {
    if (loaded[name]) gl.deleteTexture(loaded[name]);
    loaded[name] = image ? uploadImage(image) : null;
  }

  function setMask(image) {
    if (maskTex) gl.deleteTexture(maskTex);
    maskTex = image ? uploadImage(image) : null;
  }

  function update(params) {
    warnings.length = 0;
    if (!sourceTex || !width) return warnings;
    factors = params.factors;
    wrapS = params.tileX ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    wrapT = params.tileY ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    used.clear();
    const photo = rt('lin', width, height);
    draw('linear', photo, { uTex: sourceTex }, {});
    let albSource = photo;
    if (params.albedoMode === 'load' && loaded.albedo) {
      albSource = rt('tmpA', width, height);
      draw('linear', albSource, { uTex: loaded.albedo }, {});
    }
    const albedo = rt('albedo', width, height);
    const skipDelight = params.albedoMode === 'load' && loaded.albedo && !params.delightLoaded;
    let shadeScale = 1;
    if (skipDelight) {
      draw('copy', albedo, { uTex: albSource }, { uFlip: 0 });
    } else {
      const coarse = blurCoarse(albSource);
      const delighted = rt('blur8', width, height);
      const white = params.whiteBalance || [1, 1, 1];
      draw('delight', delighted, { uSrc: albSource, uBlur: coarse }, {
        uStrength: params.delight,
        uHighlight: params.highlight,
        uWhite: white,
      });
      const mean = meanOf(delighted);
      const luma = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
      const scale = params.targetMean / Math.max(0.02, luma);
      shadeScale = scale;
      draw('norm', albedo, { uTex: delighted }, { uScale: scale });
    }

    const albPyramid = blurPyramid(albedo, 'a');
    let heightMap = rt('height', width, height, true);
    draw('height', heightMap, { uAlb: albedo, uSrc: photo, uB0: albPyramid[0], uB1: albPyramid[1], uB2: albPyramid[2], uB3: albPyramid[3] }, {
      uReliefMix: params.heightRelief,
      uContrast: params.heightContrast,
      uBias: params.heightBias,
      uShadeScale: shadeScale,
      uW: params.heightWeights,
    });
    if (params.heightMode === 'load' && loaded.height) {
      heightMap = rt('heightL', width, height, true);
      draw('copy', heightMap, { uTex: loaded.height }, { uFlip: params.invertHeight ? 1 : 0 });
    } else if (params.heightMode === 'flat') {
      heightMap = rt('heightF', width, height, true);
      draw('fill', heightMap, {}, { uColor: [params.flatHeight, params.flatHeight, params.flatHeight, 1] });
    }
    // Without relief the albedo pyramid is dead here, so the height pyramid takes its targets.
    const reliefOn = params.relief > 0 && params.heightMode !== 'load';
    const hPrefix = reliefOn ? 'h' : 'a';
    const freePrefix = reliefOn ? 'a' : 'h';
    const hPyramid = blurPyramid(heightMap, hPrefix);
    const texel = [1 / width, 1 / height];
    let normal = rt('normal', width, height);
    draw('normal', normal, { uH: heightMap, uB0: hPyramid[0], uB1: hPyramid[1], uB2: hPyramid[2] }, {
      uTexel: texel,
      uBand: params.normalWeights,
      uStrength: params.normalStrength,
      uFlip: params.flipY ? 1 : 0,
    });
    if (reliefOn) {
      const light = fitLight(albedo, normal);
      draw('relief', albedo, { uAlb: albedo, uN: normal }, { uLight: light, uStrength: params.relief });
      draw('height', heightMap, { uAlb: albedo, uSrc: photo, uB0: albPyramid[0], uB1: albPyramid[1], uB2: albPyramid[2], uB3: albPyramid[3] }, {
        uReliefMix: params.heightRelief,
        uContrast: params.heightContrast,
        uBias: params.heightBias,
        uShadeScale: shadeScale,
        uW: params.heightWeights,
      });
      const again = blurPyramid(heightMap, hPrefix);
      draw('normal', normal, { uH: heightMap, uB0: again[0], uB1: again[1], uB2: again[2] }, {
        uTexel: texel,
        uBand: params.normalWeights,
        uStrength: params.normalStrength,
        uFlip: params.flipY ? 1 : 0,
      });
    }
    const detail = rt('detail', width, height);
    const cut = params.detailCutoff;
    draw('normal', detail, { uH: heightMap, uB0: hPyramid[0], uB1: hPyramid[1], uB2: hPyramid[2] }, {
      uTexel: texel,
      uBand: [0, (1 - cut) * 0.25, 0.65, 1],
      uStrength: params.normalStrength,
      uFlip: params.flipY ? 1 : 0,
    });
    if (params.normalMode === 'load' && loaded.normal) {
      const base = rt('nload', width, height);
      draw('copy', base, { uTex: loaded.normal }, { uFlip: params.flipY ? 1 : 0 });
      const blue = meanOf(base);
      if (blue[2] < 0.62) warnings.push('objectSpace');
      if (params.addDetail) {
        const flat = rt('tmpA', width, height);
        const nsoft = rt('tmpB', width, height);
        draw('blur', nsoft, { uTex: base }, { uStep: [3 / width, 3 / height] });
        draw('flatMask', flat, { uBase: base, uBlur: nsoft }, { uAmount: params.detailFlatOnly });
        let gain = params.detailStrength;
        if (params.detailAuto) {
          const dMean = meanOf(detail);
          const mag = Math.hypot(dMean[0] - 0.5, dMean[1] - 0.5);
          gain *= mag < 0.02 ? 1 : Math.max(0.25, Math.min(2.5, 0.08 / mag));
        }
        const mask = params.atlas && maskTex ? { tex: maskTex } : flat;
        draw('rnm', normal, { uBase: base, uDetail: detail, uMask: mask }, {
          uGain: gain,
          uUseMask: params.detailFlatOnly > 0 || (params.atlas && maskTex) ? 1 : 0,
        });
      } else {
        draw('copy', normal, { uTex: base }, { uFlip: 0 });
      }
    } else if (params.normalMode === 'flat') {
      draw('fill', normal, {}, { uColor: [0.5, 0.5, 1, 1] });
    }
    if (params.normalSmooth > 0.001 && params.normalMode !== 'flat') {
      const a = rt('tmpA', width, height);
      const b = rt('tmpB', width, height);
      const r1 = params.normalSmooth * 1.5;
      const r2 = params.normalSmooth * 3;
      draw('nsmooth', a, { uTex: normal }, { uStep: [r1 / width, 0] });
      draw('nsmooth', b, { uTex: a }, { uStep: [0, r1 / height] });
      draw('nsmooth', a, { uTex: b }, { uStep: [r2 / width, 0] });
      draw('nsmooth', normal, { uTex: a }, { uStep: [0, r2 / height] });
    }

    const addDetail = (target, generate, enabled, amount) => {
      if (!enabled || amount <= 0) return;
      const gen = rt('detailGen', width, height, true);
      generate(gen);
      const pyramid = blurPyramid(gen, freePrefix);
      const merged = rt('tmpA', width, height);
      draw('addHP', merged, { uBase: target, uGen: gen, uB0: pyramid[0], uB1: pyramid[1], uB2: pyramid[2] }, {
        uGain: amount,
        uSize: params.mapDetailSize,
      });
      draw('copy', target, { uTex: merged }, { uFlip: 0 });
    };

    const ao = rt('ao', width, height);
    const makeAo = (target) => draw('ao', target, { uH: heightMap }, {
      uDepth: params.aoDepth,
      uContrast: params.aoContrast,
    });
    if (params.aoMode === 'load' && loaded.ao) {
      draw('copy', ao, { uTex: loaded.ao }, { uFlip: params.invertAo ? 1 : 0 });
      addDetail(ao, makeAo, params.addAoDetail, params.aoDetailAmount);
    } else if (params.aoMode === 'flat') draw('fill', ao, {}, { uColor: [params.flatAo, params.flatAo, params.flatAo, 1] });
    else makeAo(ao);

    const nextKey = params.regionCount + ':' + width + ':' + (sourceTex ? 1 : 0);
    if (!labels || labelKey !== nextKey) {
      cluster(albedo, heightMap, params.regionCount);
      labelKey = nextKey;
    }
    const region = writeRegion(params.regionCount, params.regionClass, params.regionMetal);

    const rough = rt('rough', width, height);
    const makeRough = (target) => {
      const nBlur = rt('tmpB', width, height);
      draw('blur', nBlur, { uTex: normal }, { uStep: [2 / width, 2 / height] });
      draw('rough', target, {
        uRegion: region, uAO: ao, uH: heightMap, uHb: hPyramid[1], uHf: hPyramid[0], uAlb: albedo, uNb: nBlur,
      }, {
        uCavity: params.cavityRough,
        uWear: params.wearRough,
        uMicro: params.microRough,
        uSpec: params.specRough,
        uNVar: params.nvarRough,
        uMin: params.roughMin,
        uMax: params.roughMax,
        uContrast: params.roughContrast,
      });
    };
    if (params.roughMode === 'load' && loaded.roughness) {
      draw('copy', rough, { uTex: loaded.roughness }, { uFlip: 0 });
      addDetail(rough, makeRough, params.addRoughDetail, params.roughDetailAmount);
    } else if (params.roughMode === 'flat') draw('fill', rough, {}, { uColor: [params.flatRough, params.flatRough, params.flatRough, 1] });
    else makeRough(rough);
    const metal = rt('metal', width, height);
    const makeMetal = (target) => draw('metal', target, { uRegion: region, uH: heightMap, uHb: hPyramid[1] }, { uWear: params.metalWear, uSharp: params.metalSharp });
    if (params.metalMode === 'load' && loaded.metallic) {
      draw('copy', metal, { uTex: loaded.metallic }, { uFlip: 0 });
      addDetail(metal, makeMetal, params.addMetalDetail, params.metalDetailAmount);
    } else if (params.metalMode === 'flat') draw('fill', metal, {}, { uColor: [params.flatMetal, params.flatMetal, params.flatMetal, 1] });
    else makeMetal(metal);

    const opacity = rt('opacity', width, height);
    if (params.opacityMode === 'load' && loaded.opacity) {
      draw('opacity', opacity, { uH: heightMap, uHb: hPyramid[1], uRegion: region, uLoaded: loaded.opacity }, {
        uEdge: params.opacityEdge, uRagged: params.opacityRagged, uPatch: params.opacityPatch,
        uCrack: params.opacityCrack, uRegionPick: params.opacityRegion, uUseLoaded: 1,
      });
    } else if (params.opacityMode === 'flat') {
      draw('fill', opacity, {}, { uColor: [params.flatOpacity, params.flatOpacity, params.flatOpacity, 1] });
    } else {
      draw('opacity', opacity, { uH: heightMap, uHb: hPyramid[1], uRegion: region, uLoaded: albedo }, {
        uEdge: params.opacityEdge, uRagged: params.opacityRagged, uPatch: params.opacityPatch,
        uCrack: params.opacityCrack, uRegionPick: params.opacityRegion, uUseLoaded: 0,
      });
    }

    const rgb = params.flatColor || [1, 1, 1];
    const lin = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    if (params.albedoMode === 'flat') {
      const flatAlbedo = rt('albedoF', width, height);
      draw('fill', flatAlbedo, {}, { uColor: [lin[0], lin[1], lin[2], 1] });
      finals.albedo = flatAlbedo;
      tint = [1, 1, 1];
    } else {
      finals.albedo = albedo;
      tint = lin;
    }
    finals.height = heightMap;
    finals.normal = normal;
    finals.ao = ao;
    finals.rough = rough;
    finals.metal = metal;
    finals.opacity = opacity;
    mipped.clear();
    finals.detail = detail;
    finals.photo = photo;
    finals.region = region;
    rts.forEach((target, name) => {
      if (used.has(name) || name.startsWith('env')) return;
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fb);
      rts.delete(name);
    });
    return warnings;
  }

  function bakeSky(sun, sunRgb) {
    const env = {
      uEnv0: rt('env0', 512, 256, true),
      uEnv1: rt('env1', 256, 128, true),
      uEnv2: rt('env2', 128, 64, true),
      uEnv3: rt('env3', 64, 32, true),
      uEnv4: rt('env4', 32, 16, true),
      uIrr: rt('envIrr', 32, 16, true),
    };
    const key = sun.join();
    if (key === skyKey) return env;
    skyKey = key;
    draw('sky', env.uEnv0, {}, { uSun: sun, uSunColor: sunRgb });
    gl.bindTexture(gl.TEXTURE_2D, env.uEnv0.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    [env.uEnv1, env.uEnv2, env.uEnv3, env.uEnv4].forEach((out, i) => {
      draw('prefilter', out, { uEnv: env.uEnv0 }, { uEnvSize: [512, 256], uRough: (i + 1) / 4 });
    });
    draw('irradiance', env.uIrr, { uEnv: env.uEnv0 }, { uEnvSize: [512, 256] });
    if (env.uIrr.float) {
      const px = new Float32Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, env.uIrr.fb);
      gl.readPixels(0, env.uIrr.h - 1, 1, 1, gl.RGBA, gl.FLOAT, px);
      skyUp = [px[0], px[1], px[2]];
    }
    return env;
  }

  function exposureOf(sun, sunRgb) {
    const grey = sunRgb.map((c, i) => 0.18 * (c * Math.max(sun[1], 0) / Math.PI + skyUp[i]));
    return 0.7 / Math.max(0.2126 * grey[0] + 0.7152 * grey[1] + 0.0722 * grey[2], 1e-6);
  }

  function targetLuminance(sunRgb) {
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const factor = Math.min(1, lum(sunRgb) / lum(sunColor([0, 1, 0])));
    const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const horizon = 0.00154;
    return factor <= horizon
      ? 0.05 + 0.05 * smooth(0, horizon, factor)
      : 0.1 + 0.6 * smooth(horizon, 1, factor);
  }

  function exposureScale(hdr, sunRgb) {
    const lod = Math.max(0, Math.ceil(Math.log2(Math.max(hdr.w, hdr.h) / 64)));
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    const meter = rt('meter', Math.max(1, hdr.w >> lod), Math.max(1, hdr.h >> lod));
    draw('meter', meter, { uTex: hdr }, { uLod: lod });
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const buf = read(meter);
    const material = [];
    const sky = [];
    for (let i = 0; i < buf.length; i += 4) {
      const log = (buf[i] * 256 + buf[i + 1]) / 65535 * 24 - 12;
      if (buf[i + 2] >= 128) material.push(log);
      else sky.push(log);
    }
    const target = targetLuminance(sunRgb);
    const scaleOf = (logs) => {
      if (!logs.length) return null;
      logs.sort((a, b) => a - b);
      const n = logs.length;
      const lo = Math.floor(n * 0.3);
      const hi = Math.max(lo + 1, Math.ceil(n * 0.9));
      let avg = 0;
      for (let i = lo; i < hi; i++) avg += logs[i];
      avg /= hi - lo;
      const highlightOut = Math.log2(target) + logs[Math.min(n - 1, Math.floor(n * 0.97))] - avg;
      avg += Math.min(0.75 * Math.max(highlightOut - 1, 0), 2);
      const scale = target / 2 ** avg;
      return Number.isFinite(scale) ? Math.min(32, Math.max(1 / 32, scale)) : null;
    };
    const scales = [];
    const materialScale = scaleOf(material);
    const skyScale = sky.length >= buf.length * 0.02 ? scaleOf(sky) : null;
    if (materialScale != null) scales.push(materialScale);
    if (skyScale != null) scales.push(skyScale);
    if (!scales.length) return 1;
    return Math.min.apply(null, scales);
  }

  // Ease in log space. Closing down (a brighter scene) is quicker, and tiny meter noise is ignored.
  function smoothScale(target) {
    const now = performance.now();
    if (shownScale == null) {
      shownScale = target;
      exposureTime = now;
      return target;
    }
    const dt = Math.min(0.05, Math.max(0, (now - exposureTime) / 1000));
    exposureTime = now;
    const delta = Math.log(target) - Math.log(shownScale);
    if (Math.abs(delta) < 0.05) return shownScale;
    const speed = delta < 0 ? 12 : 5;
    shownScale = Math.exp(Math.log(shownScale) + delta * (1 - Math.exp(-Math.max(dt, 0.001) * speed)));
    return shownScale;
  }

  function queueExposure() {
    if (adaptQueued || !liveParams) return;
    adaptQueued = true;
    requestAnimationFrame(() => {
      adaptQueued = false;
      if (liveParams) present('preview', liveParams);
    });
  }

  // The preview sun is 22 against the game's 100000, so the EV is taken in game units.
  function bloomChain(hdr, exposure, scale) {
    const ev = -Math.log2(exposure * 22 / 100000);
    const aperture = 1.4 + Math.min(Math.max((ev + 5) / 20, 0), 1) * (22 - 1.4);
    let count = Math.min(9, Math.max(1, Math.floor(Math.log2(Math.max(hdr.w, hdr.h)) + 1) - 2));
    while (count > 1 && aperture * 0.5 <= count - 1) count--;
    if (count < 2) return null;
    const levels = [hdr];
    for (let i = 1; i < count; i++) {
      const src = levels[i - 1];
      const dst = rt('bloom' + i, Math.max(1, hdr.w >> i), Math.max(1, hdr.h >> i), true);
      draw('bloomDown', dst, { uTex: src }, { uTexel: [1 / src.w, 1 / src.h], uFirst: i === 1 ? 1 : 0, uExposure: i === 1 ? scale : 1 });
      levels.push(dst);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = count - 1; i > 1; i--) {
      const src = levels[i];
      draw('bloomUp', levels[i - 1], { uTex: src }, {
        uTexel: [1 / src.w, 1 / src.h],
        uWeight: 0.7 * Math.min(Math.max(aperture * 0.5 - i, 0), 1),
      });
    }
    gl.disable(gl.BLEND);
    return { tex: levels[1], weight: 0.7 * Math.min(Math.max(aperture * 0.5 - 1, 0), 1) };
  }

  function layoutSize(repeat) {
    const w = width * Math.max(1, repeat[0]);
    const h = height * Math.max(1, repeat[1]);
    const scale = Math.min(1, Math.max(4096, width, height) / Math.max(w, h));
    return [Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale))];
  }

  function screenSize(view, params) {
    const size = view === 'preview' && params.viewSize;
    if (size && size[0] >= 2 && size[1] >= 2) return size;
    return layoutSize(params.layout || [1, 1]);
  }

  function present(view, params) {
    if (view !== 'preview') liveParams = null;
    if (!finals.albedo) return;
    const size = screenSize(view, params);
    screenW = size[0];
    screenH = size[1];
    if (canvas.width !== screenW || canvas.height !== screenH) {
      canvas.width = screenW;
      canvas.height = screenH;
    }
    const map = {
      source: [finals.photo, 0],
      albedo: [finals.albedo, 0],
      height: [finals.height, 2],
      normal: [finals.normal, 1],
      detail: [finals.detail, 1],
      ao: [finals.ao, 2],
      rough: [finals.rough, 2],
      metal: [finals.metal, 2],
      opacity: [finals.opacity, 2],
      region: [finals.region, 1],
    };
    const repeat = params.layout || [1, 1];
    const zoom = params.zoom > 0 ? params.zoom : 1;
    const center = params.center || [0.5, 0.5];
    if (view === 'preview') {
      const inputs = {
        uAlb: finals.albedo, uN: finals.normal, uR: finals.rough, uM: finals.metal, uAO: finals.ao, uOp: finals.opacity,
      };
      Object.keys(inputs).forEach((key) => {
        const tex = inputs[key].tex;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (!mipped.has(tex)) {
          gl.generateMipmap(gl.TEXTURE_2D);
          mipped.add(tex);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      });
      const savedS = wrapS;
      const savedT = wrapT;
      wrapS = gl.REPEAT;
      wrapT = gl.REPEAT;
      const sun = sunDirection(params.light || [0.3, 0.4]);
      const sunRgb = sunColor(sun);
      const env = bakeSky(sun, sunRgb);
      Object.assign(inputs, env);
      const hdr = floatOk ? rt('litHdr', screenW, screenH, true) : null;
      draw('preview', hdr, inputs, {
        uDirect: hdr ? 0 : 1,
        uFactor: [factors.roughness, factors.metallic, factors.opacity, factors.normal],
        uTint: tint,
        uSun: sun,
        uSunColor: sunRgb,
        uRes: [width, height],
        uView: [screenW, screenH],
        uRot: params.rot || IDENTITY3,
        uRepeatX: repeat[0],
        uRepeatY: repeat[1],
        uShape: PREVIEW_SHAPES[params.shape] || 0,
        uSeam: params.seamLines ? 1 : 0,
        uZoom: zoom,
        uCenter: center,
        uSS: screenW * screenH <= 4200000 ? 1 : 0,
      });
      wrapS = savedS;
      wrapT = savedT;
      Object.keys(inputs).forEach((key) => {
        gl.bindTexture(gl.TEXTURE_2D, inputs[key].tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      });
      if (hdr) {
        const target = exposureScale(hdr, sunRgb);
        let scale = target;
        if (params.viewSize) {
          liveParams = params;
          scale = smoothScale(target);
          if (Math.abs(Math.log(target / scale)) > 0.05) queueExposure();
        }
        const bloom = bloomChain(hdr, exposureOf(sun, sunRgb) * scale, scale);
        draw('litFinal', null, { uHdr: hdr, uBloom: bloom ? bloom.tex : hdr }, {
          uBloomScale: bloom ? bloom.weight : 0,
          uExposure: scale,
        });
      }
      return;
    }
    const chosen = map[view] || map.albedo;
    const before = view === 'albedo' ? finals.photo : chosen[0];
    draw('show', null, { uTex: chosen[0], uBefore: before }, {
      uSplit: params.split == null ? 0 : params.split,
      uMode: chosen[1],
      uRepeatX: repeat[0],
      uRepeatY: repeat[1],
      uSeam: params.seamLines ? 1 : 0,
      uZoom: zoom,
      uCenter: center,
      uMul: view === 'albedo' ? tint : [1, 1, 1],
    });
  }

  function thumbnails(targets) {
    if (!finals.albedo) return;
    Object.keys(targets).forEach((view) => {
      present(view, { split: 0, layout: [1, 1], seamLines: false, shape: 'plane' });
      const thumb = targets[view];
      thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    });
  }

  function resize(w, h) {
    width = w;
    height = h;
    screenW = w;
    screenH = h;
    canvas.width = w;
    canvas.height = h;
    labels = null;
  }

  function readMap(name) {
    const target = name === 'source' ? finals.photo : finals[name];
    if (!target) return null;
    if (name === 'albedo') {
      const shown = rt('tmpA', width, height);
      draw('show', shown, { uTex: target, uBefore: target }, { uSplit: 0, uMode: 0, uRepeatX: 1, uRepeatY: 1, uSeam: 0, uZoom: 1, uCenter: [0.5, 0.5], uMul: [1, 1, 1] });
      return { rgba: read(shown), w: width, h: height };
    }
    return { rgba: read(target), w: width, h: height };
  }

  function release() {
    rts.forEach((target) => {
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fb);
    });
    rts.clear();
    skyKey = '';
    Object.keys(loaded).forEach((key) => {
      if (loaded[key]) gl.deleteTexture(loaded[key]);
      loaded[key] = null;
    });
    if (sourceTex) gl.deleteTexture(sourceTex);
    if (maskTex) gl.deleteTexture(maskTex);
    sourceTex = null;
    maskTex = null;
    labels = null;
    Object.keys(finals).forEach((key) => delete finals[key]);
    gl.getError();
  }

  function maxSize() {
    return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 4096;
  }

  return {
    setSource, setLoaded, setMask, update, present, thumbnails, resize, readMap, warnings, release, maxSize,
    lost() { return gl.isContextLost(); },
    size() { return { w: width, h: height }; },
  };
}
