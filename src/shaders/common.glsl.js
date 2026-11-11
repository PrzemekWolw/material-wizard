export const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vUv = p;
}`;

export const EQUIRECT = `const float PI = 3.14159265;
vec3 dirOf(vec2 uv) {
  float phi = (uv.x - 0.5) * 2.0 * PI;
  float theta = (uv.y - 0.5) * PI;
  return vec3(sin(phi) * cos(theta), sin(theta), cos(phi) * cos(theta));
}
vec2 uvOf(vec3 d) {
  return vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, clamp(asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5, 0.002, 0.998));
}`;

export const SRGB = `vec3 toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}`;

export const TONEMAP = `${SRGB}
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
}
vec3 presentSRGB(vec3 lin) {
  vec3 s = toSRGB(tonemap(lin));
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  return s + (n - 0.5) / 255.0;
}`;

// Soft shoulder above 8, so the sun disc stays finite.
export const KNEE = `vec3 skyKnee(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  const float k = 8.0;
  if (m <= k) return c;
  return c * (k * (2.0 - exp(-(m - k) / k)) / m);
}`;

export const ATMOSPHERE = `${KNEE}
const float RE = 6371e3;
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
// 0 in the planet's shadow, fading in across the last few km above the surface.
float sunLit(vec3 p, vec3 s) {
  float b = dot(p, s);
  float h2 = b * b - (dot(p, p) - RE * RE);
  if (h2 >= 0.0 && -b - sqrt(h2) > 1.0) return 0.0;
  if (b >= 0.0) return 1.0;
  return smoothstep(0.0, 4000.0, length(p - s * b) - RE);
}
bool scatter(vec3 d, vec3 s, out vec3 col, out vec3 trans) {
  vec3 o = vec3(0.0, RE + 2.0, 0.0);
  float tEnd = rsi(o, d, RA).y;
  float g = rsi(o, d, RE).x;
  bool ground = g > 0.0;
  if (ground) tEnd = g;
  float mu = dot(d, s);
  float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float gg = MIE_G * MIE_G;
  float pm = 3.0 / (8.0 * PI) * ((1.0 - gg) * (1.0 + mu * mu)) / ((2.0 + gg) * pow(1.0 + gg - 2.0 * MIE_G * mu, 1.5));
  float odR = 0.0;
  float odM = 0.0;
  vec3 totR = vec3(0.0);
  vec3 totM = vec3(0.0);
  const int N = 24;
  for (int i = 0; i < N; i++) {
    float u0 = float(i) / float(N);
    float u1 = float(i + 1) / float(N);
    float a = tEnd * u0 * u0;
    float b = tEnd * u1 * u1;
    float seg = b - a;
    vec3 p = o + d * (0.5 * (a + b));
    float h = max(0.0, length(p) - RE);
    float hr = exp(-h / HR) * seg;
    float hm = exp(-h / HM) * seg;
    odR += hr;
    odM += hm;
    float lit = sunLit(p, s);
    if (lit <= 0.0) continue;
    float tSun = max(rsi(p, s, RA).y, 1.0);
    float lr = 0.0;
    float lm = 0.0;
    const int M = 8;
    for (int j = 0; j < M; j++) {
      float v0 = float(j) / float(M);
      float v1 = float(j + 1) / float(M);
      float c0 = tSun * v0 * v0;
      float c1 = tSun * v1 * v1;
      float hl = max(0.0, length(p + s * (0.5 * (c0 + c1))) - RE);
      lr += exp(-hl / HR) * (c1 - c0);
      lm += exp(-hl / HM) * (c1 - c0);
    }
    vec3 att = exp(-(BM * (odM + lm) + BR * (odR + lr)));
    totR += hr * att * lit;
    totM += hm * att * lit;
  }
  col = SUN * (pr * BR * totR + pm * BM * totM);
  trans = exp(-(BR * odR + BM * odM));
  return ground;
}`;

export const HAMMERSLEY = `vec2 hammersley(uint i, uint n) {
  uint b = i;
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return vec2(float(i) / float(n), float(b) * 2.3283064365386963e-10);
}`;

export const FIELD = `float field(vec2 uv) {
  float u = uv.x - 0.5;
  float v = uv.y - 0.5;
  float tau = 6.2831853;
  float x1 = uPeriodic.x > 0.5 ? cos(tau * uv.x) : u;
  float x2 = uPeriodic.x > 0.5 ? sin(tau * uv.x) : u * u - 1.0 / 12.0;
  float y1 = uPeriodic.y > 0.5 ? cos(tau * uv.y) : v;
  float y2 = uPeriodic.y > 0.5 ? sin(tau * uv.y) : v * v - 1.0 / 12.0;
  float xy = uPeriodic.x > 0.5 || uPeriodic.y > 0.5 ? 0.0 : u * v;
  return dot(uFitA, vec3(x1, x2, y1)) + dot(uFitB, vec2(y2, xy));
}`;

// Same basis as FIELD. The quadratic terms are centred, so every term but the constant averages to 0.
export function fieldBasis(uu, vv, periodic) {
  const tau = Math.PI * 2;
  const u = uu - 0.5;
  const v = vv - 0.5;
  return [
    1,
    periodic[0] ? Math.cos(tau * uu) : u,
    periodic[0] ? Math.sin(tau * uu) : u * u - 1 / 12,
    periodic[1] ? Math.cos(tau * vv) : v,
    periodic[1] ? Math.sin(tau * vv) : v * v - 1 / 12,
    periodic[0] || periodic[1] ? 0 : u * v,
  ];
}
