import { FIELD } from './common.glsl.js';

export const ALBEDO = {
  lightmask: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform vec3 uPick0;
uniform vec3 uPick1;
uniform vec3 uPick2;
uniform vec3 uPick3;
uniform float uCount;
uniform float uRange;
vec3 chroma(vec3 c) { return c / max(c.r + c.g + c.b, 0.0001); }
void main() {
  vec3 c = chroma(texture(uBlur, vUv).rgb);
  float d = distance(c, chroma(uPick0));
  if (uCount > 1.5) d = min(d, distance(c, chroma(uPick1)));
  if (uCount > 2.5) d = min(d, distance(c, chroma(uPick2)));
  if (uCount > 3.5) d = min(d, distance(c, chroma(uPick3)));
  float m = 1.0 - smoothstep(uRange, uRange * 2.0, d);
  o = vec4(texture(uSrc, vUv).rgb * m, m);
}`,

  delight: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler2D uField;
uniform sampler2D uFieldWide;
uniform float uMasked;
uniform vec3 uLit;
uniform float uStrength;
uniform float uHighlight;
uniform float uShadow;
uniform vec3 uWhite;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 blur = texture(uBlur, vUv).rgb;
  float sumS = max(src.r + src.g + src.b, 0.0001);
  float sumB = max(blur.r + blur.g + blur.b, 0.0001);
  float cd = distance(src / sumS, blur / sumB);
  float w = uStrength * mix(1.0 - smoothstep(0.04, 0.22, cd), 1.0, uMasked);
  float y = max(luma(src), 0.0001);
  float yb = max(luma(blur), 0.0001);
  vec4 f = texture(uField, vUv);
  vec4 fw = texture(uFieldWide, vUv);
  vec3 fieldFine = (f.rgb + 0.02 * blur) / (f.a + 0.02);
  vec3 fieldWide = (fw.rgb + 0.02 * blur) / (fw.a + 0.02);
  float yf = uMasked > 0.5 ? max(luma(mix(fieldWide, fieldFine, smoothstep(0.1, 0.5, f.a))), 0.0001) : yb;
  vec3 alb = src * pow(0.5 / yf, w);
  float mx = max(src.r, max(src.g, src.b));
  float mn = min(src.r, min(src.g, src.b));
  float sat = mx <= 0.0001 ? 0.0 : (mx - mn) / mx;
  float hi = smoothstep(0.04, 0.28, y - yb) * (1.0 - sat);
  alb = mix(alb, (blur / sumB) * yb, hi * uHighlight);
  alb *= uWhite;
  float sumL = max(uLit.r + uLit.g + uLit.b, 0.0001);
  float yLit = max(luma(uLit), 0.0001);
  float stone = smoothstep(0.15, 0.35, distance(blur / sumB, uLit / sumL));
  float lift = (1.0 - smoothstep(0.70, 0.92, yb / yLit)) * (1.0 - stone) * uShadow;
  vec3 tint = (uLit / sumL) / max(blur / sumB, vec3(0.0001));
  float gain = pow(min(yLit / yb, 4.0), 1.0 - w);
  alb *= mix(vec3(1.0), tint * gain, lift);
  alb = clamp(alb, 0.0, 4.0);
  o = vec4(alb, mix(1.0, hi, step(0.001, uStrength + uHighlight)));
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

  even: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uEven;
uniform vec3 uFitA;
uniform vec2 uFitB;
uniform vec2 uPeriodic;
uniform vec4 uShift;
${FIELD}
void main() {
  vec4 c = texture(uTex, vUv);
  float tau = 6.2831853;
  float gain = exp(-uEven * field(vUv));
  gain *= exp2(uShift.x * cos(tau * (vUv.x - uShift.y)));
  gain *= exp2(uShift.z * cos(tau * (1.0 - vUv.y - uShift.w)));
  o = vec4(clamp(c.rgb * gain, 0.0, 1.0), c.a);
}`,

  level: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uH;
uniform float uAmount;
uniform vec3 uFitA;
uniform vec2 uFitB;
uniform vec2 uPeriodic;
${FIELD}
void main() {
  float h = texture(uH, vUv).r;
  o = vec4(vec3(clamp(h - field(vUv) * uAmount, 0.0, 1.0)), 1.0);
}`,

  relief: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uAlb;
uniform sampler2D uN;
uniform vec3 uLight;
uniform float uStrength;
uniform float uMean;
uniform float uFadeHi;
void main() {
  vec4 alb = texture(uAlb, vUv);
  vec3 n = normalize(texture(uN, vUv).rgb * 2.0 - 1.0);
  float shade = clamp(dot(n, normalize(uLight)), 0.15, 1.0);
  float factor = clamp(uMean / shade, 0.75, 1.35);
  float fade = uFadeHi > 0.5 ? (1.0 - alb.a) : 1.0;
  factor = mix(1.0, factor, uStrength * fade);
  float top = max(alb.r, max(alb.g, alb.b)) * factor;
  if (top > 0.9) factor *= 0.9 / top;
  o = vec4(alb.rgb * factor, alb.a);
}`,
};
