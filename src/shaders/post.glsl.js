import { TONEMAP } from './common.glsl.js';

export const POST = {
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
  o = vec4(presentSRGB(c), 1.0);
}`,

  // GT7 HDR curve. Frame-buffer scale stays 1 = 100 nits.
  // uOut 0: PQ in Rec.2020 for a rec2100-pq canvas. uOut 1: extended sRGB with 1 = 250 nits paper white for a WebGPU extended canvas.
  litPq: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uBloomScale;
uniform float uExposure;
uniform float uPeak;
uniform float uMid;
uniform float uLin;
uniform float uToe;
uniform float uKA;
uniform float uKB;
uniform float uKC;
uniform float uOut;
${TONEMAP}
float evalCurve(float x) {
  if (x < 0.0) return 0.0;
  float w = smoothstep(0.0, uMid, x);
  if (x < uLin * uPeak) {
    float toeMapped = x <= 0.0 ? 0.0 : uMid * pow(x / uMid, uToe);
    return (1.0 - w) * toeMapped + w * x;
  }
  return uKA + uKB * exp(x * uKC);
}
vec3 pqFromNits(vec3 nits) {
  vec3 y = clamp(nits, 0.0, 10000.0) / 10000.0;
  vec3 ym = pow(max(y, 0.0), vec3(0.1593017578125));
  return pow((vec3(0.8359375) + 18.8515625 * ym) / (1.0 + 18.6875 * ym), vec3(78.84375));
}
// Rows come out top first, so readPixels needs no flip.
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 c709 = textureLod(uHdr, uv, 0.0).rgb * uExposure + uBloomScale * textureLod(uBloom, uv, 0.0).rgb;
  vec3 c = max(TO_2020 * c709, 0.0);
  vec3 ucs = toIctcp(c);
  vec3 skewed = vec3(evalCurve(c.r), evalCurve(c.g), evalCurve(c.b));
  float chroma = 1.0 - smoothstep(0.98, 1.16, ucs.x / max(toIctcp(vec3(uPeak)).x, 1e-4));
  vec3 scaled = max(fromIctcp(vec3(toIctcp(skewed).x, ucs.yz * chroma)), 0.0);
  vec3 mapped = min(mix(skewed, scaled, 0.6), vec3(uPeak));
  if (uOut > 0.5) {
    vec3 rel = max(TO_709 * mapped, 0.0) / 2.5;
    o = vec4(toSRGB(rel), 1.0);
    return;
  }
  o = vec4(pqFromNits(mapped * 100.0), 1.0);
}`,

  // One mip texel of the lit frame as log2 luminance (-12..12) packed into 16 bits, plus coverage (sky is alpha 0, material is 1).
};
