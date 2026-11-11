import { LIT_SHADE } from './lit.glsl.js';

export const TERRAIN = {
  // Roughness, ao and height in one texture, like the game's packed terrain arrays.
  tpack: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uR;
uniform sampler2D uAO;
uniform sampler2D uH;
void main() { o = vec4(texture(uR, vUv).r, texture(uAO, vUv).r, texture(uH, vUv).r, 1.0); }`,

  // Signed overlay around 0.5: the map minus its blur, or (uUseMean) a blur minus the image mean.
  recenter: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uBlur;
uniform vec4 uMean;
uniform float uUseMean;
uniform float uSrcGain;
uniform float uBlurGain;
void main() {
  vec3 b = uUseMean > 0.5 ? uMean.rgb : texture(uBlur, vUv).rgb * uBlurGain;
  o = vec4(clamp(0.5 + texture(uTex, vUv).rgb * uSrcGain - b, 0.0, 1.0), 1.0);
}`,

  // A ground plane seen from a camera at a height, blended like blendTerrainMaterials in terrainImpl.hlsl.
  terrainPreview: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uBaseB;
uniform sampler2D uBaseN;
uniform sampler2D uBaseD;
uniform sampler2D uMacB;
uniform sampler2D uMacN;
uniform sampler2D uMacD;
uniform sampler2D uDetB;
uniform sampler2D uDetN;
uniform sampler2D uDetD;
uniform vec2 uView;
uniform vec2 uJitter;
uniform float uZoom;
uniform vec2 uCenter;
uniform float uDirect;
uniform vec3 uTint;
uniform vec3 uCam;
uniform vec3 uSizes;
uniform vec4 uMacroDist;
uniform vec4 uDetailDist;
uniform vec4 uAtten;
uniform vec4 uStrB;
uniform vec4 uStrN;
uniform vec4 uStrR;
uniform vec4 uStrAO;
uniform vec4 uStrH;
uniform float uFlatBase;
uniform float uDebug;
uniform float uBlend;
${LIT_SHADE}
const float FOCAL = 0.866;
float ramp(float x, float a, float b) {
  return b > a ? clamp((x - a) / (b - a), 0.0, 1.0) : (x > a ? 1.0 : 0.0);
}
vec3 blendDetailMacro(vec4 d, float x) {
  return vec3(ramp(x, d.x, d.y), ramp(x, d.y, d.z), ramp(x, d.z, d.w));
}
float strength(vec3 f, vec2 atten, vec2 s) {
  return mix(mix(atten.x * s.x, s.x, f.x), mix(s.y, atten.y * s.y, f.z), f.y);
}
// Macro and detail factor of one group; 0 past the 1000 m and 250 m sampling caps.
vec2 factors(vec4 s, float dist) {
  float m = dist < min(1000.0, uMacroDist.w) ? strength(blendDetailMacro(uMacroDist, dist), 1.0 - uAtten.xy, s.xy) : 0.0;
  float d = dist < min(250.0, uDetailDist.w) ? strength(blendDetailMacro(uDetailDist, dist), 1.0 - uAtten.zw, s.zw) : 0.0;
  return vec2(m, d);
}
float overlay(float base, float macro, float detail, vec2 f) {
  return clamp(clamp(base + (macro * 2.0 - 1.0) * f.x, 0.0, 1.0) + (detail * 2.0 - 1.0) * f.y, 0.0, 1.0);
}
// decodeNormalBC5 takes z from the raw 0..1 values. Its y flip is left out: the tool's normals and the game's
// terrain files share one convention, and this plane's tangent frame already matches it.
vec3 decode(vec3 raw) {
  return normalize(vec3(raw.xy * 2.0 - 1.0, sqrt(1.0 - clamp(dot(raw.xy, raw.xy), 0.0, 1.0))));
}
uint murmur(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
float hash01(ivec2 p) {
  uint h = murmur(0u);
  h = murmur(h ^ (uint(p.x) * 0x85ebca6bu));
  h = murmur(h ^ (uint(p.y) * 0x9e3779b9u));
  return float(murmur(h) & 0x00FFFFFFu) / 16777216.0;
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  return mix(mix(hash01(c), hash01(c + ivec2(1, 0)), f.x), mix(hash01(c + ivec2(0, 1)), hash01(c + ivec2(1, 1)), f.x), f.y);
}
vec2 layerWarp(vec2 p) {
  return (vec2(valueNoise(p * 1.3), valueNoise(p * 1.3 + 37.2)) * 2.0 - 1.0) * 0.5;
}
float heightBlend(float height, inout float maxHeight, inout float weights) {
  float diff = clamp((height - maxHeight) / 0.25, 0.0, 1.0);
  weights *= 1.0 - diff;
  maxHeight = max(maxHeight, height);
  float w = clamp((height - (maxHeight - 0.5)) / 0.5, 0.0, 1.0);
  weights += w;
  return w / (weights + 1e-20);
}
struct Mat { vec3 alb; vec3 n; float rough; float ao; float h; };
Mat material(vec2 g, float dist) {
  vec2 ub = g / uSizes.x;
  vec2 fb = vec2(fract(ub.x), 1.0 - fract(ub.y));
  float lod = uFlatBase > 0.5 ? 20.0 : -1.0;
  vec3 bB, bN;
  vec4 bD;
  if (lod > 0.0) {
    bB = textureLod(uBaseB, fb, lod).rgb;
    bN = textureLod(uBaseN, fb, lod).rgb;
    bD = textureLod(uBaseD, fb, lod);
  } else {
    vec2 dx = dFdx(ub) * vec2(1.0, -1.0);
    vec2 dy = dFdy(ub) * vec2(1.0, -1.0);
    bB = textureGrad(uBaseB, fb, dx, dy).rgb;
    bN = textureGrad(uBaseN, fb, dx, dy).rgb;
    bD = textureGrad(uBaseD, fb, dx, dy);
  }
  bB *= uTint;
  vec2 um = g / uSizes.y;
  vec2 ud = g / uSizes.z;
  vec3 mB = texture(uMacB, um).rgb;
  vec3 mN = texture(uMacN, um).rgb;
  vec4 mD = texture(uMacD, um);
  vec3 dB = texture(uDetB, ud).rgb;
  vec3 dN = texture(uDetN, ud).rgb;
  vec4 dD = texture(uDetD, ud);
  vec2 fB = factors(uStrB, dist);
  vec2 fN = factors(uStrN, dist);
  vec2 fR = factors(uStrR, dist);
  vec2 fA = factors(uStrAO, dist);
  vec2 fH = factors(uStrH, dist);
  if (uDebug > 0.5 && uDebug < 1.5) { fB = fN = fR = fA = fH = vec2(0.0); }
  Mat m;
  m.alb = vec3(overlay(bB.r, mB.r, dB.r, fB), overlay(bB.g, mB.g, dB.g, fB), overlay(bB.b, mB.b, dB.b, fB));
  vec3 n = decode(bN);
  if (fN.x > 0.0) n = normalize(mix(n, decode(mN), fN.x));
  if (fN.y > 0.0) n = normalize(mix(n, decode(dN), fN.y));
  m.n = n;
  m.rough = overlay(bD.r, mD.r, dD.r, fR);
  m.ao = overlay(bD.g, mD.g, dD.g, fA);
  m.h = overlay(bD.b, mD.b, dD.b, fH);
  if (uDebug > 1.5 && uDebug < 2.5) m.alb = clamp(0.18 + (mB * 2.0 - 1.0) * fB.x, 0.0, 1.0);
  if (uDebug > 2.5 && uDebug < 3.5) m.alb = clamp(0.18 + (dB * 2.0 - 1.0) * fB.y, 0.0, 1.0);
  if (uDebug > 3.5) m.alb = vec3(fB.x, fB.y, 0.15) * 0.6;
  return m;
}
// A second, flat layer painted in an 8 m checker, for the height blend at the borders.
Mat otherLayer() {
  Mat m;
  m.alb = vec3(0.2);
  m.n = vec3(0.0, 0.0, 1.0);
  m.rough = 0.9;
  m.ao = 1.0;
  m.h = 0.5;
  return m;
}
vec4 scene(vec2 s) {
  float viewA = uView.x / max(uView.y, 1.0);
  float pitch = radians(uCam.y);
  float cy = cos(uCam.z), sy = sin(uCam.z);
  vec3 fwd = vec3(-sy * cos(pitch), -sin(pitch), -cy * cos(pitch));
  vec3 right = vec3(cy, 0.0, -sy);
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd * FOCAL + right * s.x * viewA + up * s.y);
  float exposure = autoExposure();
  // Sampled before the sky test, so the texture derivatives come from uniform control flow.
  float t = uCam.x / max(-rd.y, 1e-4);
  vec3 P = vec3(0.0, uCam.x, 0.0) + t * rd;
  vec2 g = vec2(P.x, -P.z);
  Mat m = material(g, t);
  if (rd.y > -1e-4) {
    vec3 sky = textureLod(uEnv0, uvOf(rd), 0.0).rgb;
    float sun = smoothstep(0.99996, 0.99999, dot(rd, uSun));
    if (sun > 0.0) sky = skyKnee(sky + uSunColor * 400.0 * sun);
    return vec4(sky * exposure, 0.0);
  }
  if (uBlend > 0.5) {
    vec2 q = g / 8.0;
    vec2 cell = q + layerWarp(q) - 0.5;
    vec2 f = fract(cell + 1.0 / 512.0);
    ivec2 c = ivec2(floor(cell));
    vec4 fac = mix(mix(vec4(1, 0, 0, 0), vec4(0, 1, 0, 0), f.x), mix(vec4(0, 0, 1, 0), vec4(0, 0, 0, 1), f.x), f.y);
    ivec4 id = ivec4((c.x + c.y) & 1, (c.x + 1 + c.y) & 1, (c.x + c.y + 1) & 1, (c.x + c.y) & 1);
    for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) {
      if (a != b && id[a] == id[b]) { float v = max(fac[a], fac[b]); fac[b] = 0.0; fac[a] = v; }
    }
    Mat other = otherLayer();
    Mat outM;
    outM.alb = vec3(0.0);
    outM.n = vec3(0.0, 0.0, 1.0);
    outM.rough = 0.9;
    outM.ao = 0.0;
    outM.h = 0.0;
    float maxHeight = -1.0;
    float weights = 0.0;
    for (int i = 0; i < 4; i++) {
      if (fac[i] <= 0.0) continue;
      Mat l = other;
      if (id[i] == 0) l = m;
      float w = heightBlend(clamp(l.h, 0.0, 1.0) + fac[i] * 2.0, maxHeight, weights);
      outM.h = mix(outM.h, l.h, w);
      outM.rough = mix(outM.rough, l.rough, w);
      outM.n = mix(outM.n, l.n, w);
      outM.ao = mix(outM.ao, l.ao, w);
      outM.alb = mix(outM.alb, l.alb, w);
    }
    m = outM;
  }
  vec3 Ng = vec3(0.0, 1.0, 0.0);
  vec3 V = -rd;
  vec3 col;
  if (uDebug > 1.5) {
    vec3 illum = uSunColor * max(uSun.y, 0.0) / PI + textureLod(uIrr, uvOf(Ng), 0.0).rgb;
    col = m.alb * illum * exposure;
  } else {
    col = shade(m.alb, m.n, 1.0, m.rough, 0.0, m.ao, vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0), Ng, V) * exposure;
  }
  return vec4(col, 1.0);
}
void main() {
  float zoom = max(uZoom, 0.05);
  vec2 p = vUv + uJitter / uView;
  vec4 s = scene((p - 0.5) / zoom + uCenter - 0.5);
  vec3 hdr = min(s.rgb, vec3(60000.0));
  o = uDirect > 0.5 ? vec4(presentSRGB(hdr), 1.0) : vec4(hdr, s.a);
}`,
};
