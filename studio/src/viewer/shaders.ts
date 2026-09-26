export const MAX_CHANNELS = 16;

export const VERTEX = `#version 300 es
in vec2 aPos;
uniform vec4 uRect;      // world rect: x, y, w, h in full-resolution pixels
uniform vec4 uUV;        // texel rect: u, v, du, dv
uniform vec2 uCenter;    // camera centre (world)
uniform float uScale;    // device pixels per world pixel
uniform vec2 uViewport;  // device pixels
out vec2 vUV;
out vec2 vWorld;
void main() {
  vec2 world = uRect.xy + aPos * uRect.zw;
  vec2 screen = (world - uCenter) * uScale + 0.5 * uViewport;
  gl_Position = vec4(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0, 0.0, 1.0);
  vUV = uUV.xy + aPos * uUV.zw;
  vWorld = world;
}`;

/* Raw integer samples are windowed per channel (lo..hi -> 0..1), gamma-corrected, tinted and
   summed. Integer textures cannot be filtered by the GPU, so smooth sampling is a manual
   4-tap bilinear filter; magnified views default to nearest so each pixel is exact. */
export const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2DArray;
#define MAXC ${MAX_CHANNELS}
uniform usampler2DArray uTex;
uniform ivec2 uTexSize;
uniform int uCount;
uniform int uLayer[MAXC];
uniform vec2 uWindow[MAXC];
uniform float uInvGamma[MAXC];
uniform vec3 uColor[MAXC];
uniform float uSaturation[MAXC];
uniform bool uSmooth;
uniform bool uClip;
uniform float uGrid;
uniform float uScale;
in vec2 vUV;
in vec2 vWorld;
out vec4 outColor;

float texel(int layer, ivec2 p) {
  p = clamp(p, ivec2(0), uTexSize - 1);
  return float(texelFetch(uTex, ivec3(p, layer), 0).r);
}

float sampleLayer(int layer) {
  if (!uSmooth) return texel(layer, ivec2(floor(vUV)));
  vec2 p = vUV - 0.5;
  vec2 base = floor(p);
  vec2 f = p - base;
  ivec2 i = ivec2(base);
  float a = texel(layer, i);
  float b = texel(layer, i + ivec2(1, 0));
  float c = texel(layer, i + ivec2(0, 1));
  float d = texel(layer, i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec3 acc = vec3(0.0);
  bool clipped = false;
  for (int k = 0; k < MAXC; k++) {
    if (k >= uCount) break;
    float v = sampleLayer(uLayer[k]);
    float t = clamp((v - uWindow[k].x) / max(uWindow[k].y - uWindow[k].x, 1.0), 0.0, 1.0);
    acc += uColor[k] * pow(t, uInvGamma[k]);
    clipped = clipped || (uClip && v >= uSaturation[k]);
  }
  vec3 col = clipped ? vec3(1.0, 0.0, 0.0) : min(acc, vec3(1.0));
  if (uGrid > 0.0) {
    vec2 g = fract(vWorld);
    float onePx = 1.0 / uScale;
    col = mix(col, vec3(0.32), uGrid * float(g.x < onePx || g.y < onePx));
  }
  outColor = vec4(col, 1.0);
}`;
