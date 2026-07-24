import type { ChannelMaps } from "./synth";
import { hexToRgb } from "./palette";

// The compositor is data-driven: it packs N single-channel intensity maps into
// ceil(N/4) RGBA textures and only composites the channels the loaded dataset
// actually has (`uCount`). Capacity is 4 textures = 16 channels, which covers
// both the 5-channel real scan and the 12-plex synthetic demo with headroom.
const CHANS_PER_TEX = 4;
const MAX_TEX = 4;
const MAX_CHANNELS = CHANS_PER_TEX * MAX_TEX; // 16

export interface ViewTransform {
  zoom: number;
  panX: number; // pixels
  panY: number;
  canvasW: number;
  canvasH: number;
}

export interface ChannelUniform {
  color: string;
  /** contrast window normalized to 0..1 (data units / domain). */
  lo: number;
  hi: number;
  gamma: number;
  opacity: number;
  visible: boolean;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = vec2((aPos.x+1.0)*0.5, 1.0-(aPos.y+1.0)*0.5);
  gl_Position = vec4(aPos,0.0,1.0);
}`;

// Additive LUT blend + Reinhard-ish tone map. Each channel maps its intensity
// through a dual min/max contrast window (uLo/uHi) — the same linear ramp Viv
// applies via `contrastLimits` — then a per-channel gamma and opacity, so the
// synthetic compositor path exposes the SAME controls as the Viv pyramid path.
// The gamma exponent is guarded (>0) so pow is always defined (0.0^0.0 is NaN on
// many GPUs and would poison the pixel to black).
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform vec3 uColor[${MAX_CHANNELS}];
uniform float uLo[${MAX_CHANNELS}];
uniform float uHi[${MAX_CHANNELS}];
uniform float uGamma[${MAX_CHANNELS}];
uniform float uOpacity[${MAX_CHANNELS}];
uniform float uActive[${MAX_CHANNELS}];
uniform int uCount;
void main(){
  vec4 t0 = texture(uTex0, vUv);
  vec4 t1 = texture(uTex1, vUv);
  vec4 t2 = texture(uTex2, vUv);
  vec4 t3 = texture(uTex3, vUv);
  float inten[${MAX_CHANNELS}];
  inten[0]=t0.r; inten[1]=t0.g; inten[2]=t0.b; inten[3]=t0.a;
  inten[4]=t1.r; inten[5]=t1.g; inten[6]=t1.b; inten[7]=t1.a;
  inten[8]=t2.r; inten[9]=t2.g; inten[10]=t2.b; inten[11]=t2.a;
  inten[12]=t3.r; inten[13]=t3.g; inten[14]=t3.b; inten[15]=t3.a;
  vec3 col = vec3(0.0);
  for(int i=0;i<${MAX_CHANNELS};i++){
    if(i >= uCount) break;          // never touch channels the dataset lacks
    if(uActive[i] < 0.5) continue;  // channel toggled off
    float t = clamp((inten[i] - uLo[i]) / max(0.0005, uHi[i] - uLo[i]), 0.0, 1.0);
    t = pow(t, 1.0 / max(uGamma[i], 0.02)); // gamma>1 brightens, <1 darkens
    col += uColor[i]*t*uOpacity[i];
  }
  col = col/(col+vec3(0.82));
  col = pow(col, vec3(0.86));
  outColor = vec4(col,1.0);
}`;

export class Compositor {
  gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture[] = [];
  private posBuf: WebGLBuffer | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  imgW = 0;
  imgH = 0;
  count = 0;
  ok = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: true });
    if (!gl) return;
    this.gl = gl;
    const prog = link(gl, VERT, FRAG);
    if (!prog) return;
    this.prog = prog;
    gl.useProgram(prog);
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(8), gl.DYNAMIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    for (const n of ["uTex0", "uTex1", "uTex2", "uTex3", "uColor", "uLo", "uHi", "uGamma", "uOpacity", "uActive", "uCount"]) {
      this.loc[n] = gl.getUniformLocation(prog, n);
    }
    gl.uniform1i(this.loc.uTex0, 0);
    gl.uniform1i(this.loc.uTex1, 1);
    gl.uniform1i(this.loc.uTex2, 2);
    gl.uniform1i(this.loc.uTex3, 3);
    this.ok = true;
  }

  upload(maps: ChannelMaps) {
    const gl = this.gl;
    if (!gl) return;
    this.imgW = maps.width;
    this.imgH = maps.height;
    // Data-driven: the number of composited channels comes from the dataset.
    this.count = Math.min(maps.maps.length, MAX_CHANNELS);
    const px = maps.width * maps.height;
    for (const t of this.tex) gl.deleteTexture(t);
    this.tex = [];
    // Always create all MAX_TEX textures so every sampler has a complete,
    // valid (zero-filled where unused) texture bound.
    for (let t = 0; t < MAX_TEX; t++) {
      const rgba = new Uint8Array(px * 4);
      for (let k = 0; k < CHANS_PER_TEX; k++) {
        const ch = t * CHANS_PER_TEX + k;
        if (ch >= this.count) break;
        const src = maps.maps[ch];
        for (let i = 0; i < px; i++) rgba[i * 4 + k] = src[i];
      }
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + t);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maps.width, maps.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex.push(tex);
    }
    if (this.prog) {
      gl.useProgram(this.prog);
      gl.uniform1i(this.loc.uCount, this.count);
    }
  }

  setChannels(chs: ChannelUniform[]) {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    gl.useProgram(this.prog);
    const colors = new Float32Array(MAX_CHANNELS * 3);
    const lo = new Float32Array(MAX_CHANNELS);
    const hi = new Float32Array(MAX_CHANNELS);
    const gamma = new Float32Array(MAX_CHANNELS);
    const opacity = new Float32Array(MAX_CHANNELS);
    const active = new Float32Array(MAX_CHANNELS);
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const ch = chs[i];
      if (ch) {
        const [r, g, b] = hexToRgb(ch.color);
        colors[i * 3] = r / 255;
        colors[i * 3 + 1] = g / 255;
        colors[i * 3 + 2] = b / 255;
        lo[i] = ch.lo;
        hi[i] = ch.hi;
        gamma[i] = ch.gamma;
        opacity[i] = ch.opacity;
        active[i] = ch.visible ? 1 : 0;
      } else {
        hi[i] = 1; // safe default window [0,1]
        gamma[i] = 1; // never left at 0
        opacity[i] = 1;
      }
    }
    gl.uniform3fv(this.loc.uColor, colors);
    gl.uniform1fv(this.loc.uLo, lo);
    gl.uniform1fv(this.loc.uHi, hi);
    gl.uniform1fv(this.loc.uGamma, gamma);
    gl.uniform1fv(this.loc.uOpacity, opacity);
    gl.uniform1fv(this.loc.uActive, active);
    gl.uniform1i(this.loc.uCount, this.count);
  }

  render(view: ViewTransform) {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(view.canvasW * dpr);
    const ch = Math.round(view.canvasH * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.02, 0.027, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);

    const rect = fitRect(this.imgW, this.imgH, view);
    const toClipX = (x: number) => (x / view.canvasW) * 2 - 1;
    const toClipY = (y: number) => 1 - (y / view.canvasH) * 2;
    const x0 = toClipX(rect.x);
    const y0 = toClipY(rect.y);
    const x1 = toClipX(rect.x + rect.w);
    const y1 = toClipY(rect.y + rect.h);
    const verts = new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

export function fitRect(imgW: number, imgH: number, view: ViewTransform) {
  const base = Math.min(view.canvasW / imgW, view.canvasH / imgH);
  const s = base * view.zoom;
  const w = imgW * s;
  const h = imgH * s;
  const x = (view.canvasW - w) / 2 + view.panX;
  const y = (view.canvasH - h) / 2 + view.panY;
  return { x, y, w, h, s, base };
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("link error", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("shader error", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}
