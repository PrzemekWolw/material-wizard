import { EQUIRECT, KNEE, TONEMAP } from './common.glsl.js';

// Environment, sun and the BRDF shared by the material and terrain previews.
export const LIT_SHADE = `uniform sampler2D uEnv0;
uniform sampler2D uEnv1;
uniform sampler2D uEnv2;
uniform sampler2D uEnv3;
uniform sampler2D uEnv4;
uniform sampler2D uIrr;
uniform vec3 uSun;
uniform vec3 uSunColor;
${EQUIRECT}
${KNEE}
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
// Sun, sky reflection and ambient for one surface point; tn is the tangent-space normal as sampled.
vec3 shade(vec3 alb, vec3 tn, float strength, float rough, float metal, float ao, vec3 T, vec3 B, vec3 Ng, vec3 V) {
  float len = max(length(tn), 0.1);
  tn /= len;
  tn = normalize(vec3(tn.xy * strength, tn.z));
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
  return diffuse + spec + refl;
}`;

export const LIT = {
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
uniform sampler2D uSky;
uniform vec2 uRes;
uniform vec2 uView;
uniform mat3 uRot;
uniform float uRepeatX;
uniform float uRepeatY;
uniform float uShape;
uniform float uSeam;
uniform float uAlphaBg;
uniform float uZoom;
uniform vec2 uCenter;
uniform vec2 uJitter;
uniform float uDirect;
uniform vec4 uFactor;
uniform vec3 uTint;
const float FOCAL = 3.0;
${LIT_SHADE}
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
    vec3 sky = texture(uSky, gl_FragCoord.xy / uView).rgb;
    float sun = smoothstep(0.99996, 0.99999, dot(rd, uSun));
    if (sun > 0.0) sky = skyKnee(sky + uSunColor * 400.0 * sun);
    return vec4(sky * exposure, 0.0);
  }
  vec3 Ng = uRot * h.N;
  vec3 T = uRot * h.T;
  vec3 B = uRot * h.B;
  vec3 V = -rd;
  float ndvg = abs(dot(Ng, V));
  // Pixel footprint on the surface as uv gradients: stretched by 1/cos along the view direction, for
  // anisotropic filtering. Halved, because the jittered samples average over the pixel.
  float footprint = 0.5 * h.t * fit / (max(uZoom, 0.05) * uView.y * FOCAL);
  vec2 along = vec2(dot(V, T), dot(V, B));
  along = dot(along, along) > 1e-8 ? normalize(along) : vec2(1.0, 0.0);
  vec2 duv = footprint / (h.tw * uRes);
  vec2 gx = along * duv / max(ndvg, 0.05);
  vec2 gy = vec2(-along.y, along.x) * duv;
  vec2 uv = h.uv * vec2(uRepeatX, uRepeatY);
  vec3 alb = textureGrad(uAlb, uv, gx, gy).rgb * uTint;
  vec3 tn = textureGrad(uN, uv, gx, gy).rgb * 2.0 - 1.0;
  // The game multiplies the maps by the material factors: roughness, metallic, opacity, normal strength (xy).
  float rough = textureGrad(uR, uv, gx, gy).r * uFactor.x;
  float metal = textureGrad(uM, uv, gx, gy).r * uFactor.y;
  float ao = textureGrad(uAO, uv, gx, gy).r;
  float op = textureGrad(uOp, uv, gx, gy).r * uFactor.z;
  // Exposed HDR, the checker and seam colours are picked to land at their old display values.
  vec3 col = shade(alb, tn, uFactor.w, rough, metal, ao, T, B, Ng, V) * exposure;
  vec3 behind = uAlphaBg > 0.5
    ? texture(uSky, gl_FragCoord.xy / uView).rgb * exposure
    : (mod(floor(gl_FragCoord.x / 12.0) + floor(gl_FragCoord.y / 12.0), 2.0) < 0.5 ? vec3(0.085) : vec3(0.2));
  col = mix(behind, col, op);
  if (uSeam > 0.5 && uShape < 0.5) {
    vec2 f = fract(uv);
    if (min(f.x, f.y) < 0.012 / max(uZoom, 1.0)) col = mix(col, vec3(1.9, 0.7, 0.26), 0.75);
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

  // Karis average + quadratic threshold on the first downsample, 13 tap downsample after, tent upsample added back with blending.
};
