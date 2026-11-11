import { EQUIRECT, ATMOSPHERE, HAMMERSLEY } from './common.glsl.js';

export const SKY = {
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
  o = vec4(skyKnee(col), 1.0);
}`,

  // The equirect sky is too coarse to fill the view, so the background is drawn at half the screen size.
  // The sun disc is added at full size in the preview shader.
  skyView: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec2 uRes;
uniform vec2 uView;
uniform float uRepeatX;
uniform float uRepeatY;
uniform float uZoom;
uniform vec2 uCenter;
const float FOCAL = 3.0;
${EQUIRECT}
${ATMOSPHERE}
void main() {
  float texA = uRes.x / max(uRes.y, 1.0);
  float viewA = uView.x / max(uView.y, 1.0);
  vec2 rep = vec2(max(uRepeatX, 1.0), max(uRepeatY, 1.0));
  float fit = max(rep.y, texA * rep.x / rep.y / viewA);
  float zoom = max(uZoom, 0.05);
  vec2 s = (vUv - 0.5) / zoom + uCenter - 0.5;
  vec3 rd = normalize(vec3(s.x * viewA * fit, s.y * fit, -FOCAL));
  vec3 col = vec3(0.0);
  vec3 trans = vec3(1.0);
  bool ground = scatter(rd, uSun, col, trans);
  if (ground) col += trans * GROUND / PI * uSunColor * max(uSun.y, 0.0) * 1.3;
  o = vec4(skyKnee(col), 1.0);
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
};
