import type { ChannelMaps } from "./synth";
import { hexToRgb } from "./palette";

// The shader packs up to 12 single-channel intensity maps into 3 RGBA textures.
const MAX_CHANNELS = 12;

export interface ViewTransform {
  zoom: number;
  panX: number; // pixels
  panY: number;
  canvasW: number;
  canvasH: number;
}

export interface ChannelUniform {
  color: string;
  gain: number;
  gamma: number;
  visible: boolean;
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = vec2((aPos.x+1.0)*0.5, 1.0-(aPos.y+1.0)*0.5);
  gl_Position = vec4(aPos,0.0,1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform vec3 uColor[12];
uniform float uGain[12];
uniform float uGamma[12];
uniform float uActive[12];
void main(){
  vec4 a = texture(uTex0, vUv);
  vec4 b = texture(uTex1, vUv);
  vec4 c = texture(uTex2, vUv);
  float inten[12];
  inten[0]=a.r; inten[1]=a.g; inten[2]=a.b; inten[3]=a.a;
  inten[4]=b.r; inten[5]=b.g; inten[6]=b.b; inten[7]=b.a;
  inten[8]=c.r; inten[9]=c.g; inten[10]=c.b; inten[11]=c.a;
  vec3 col = vec3(0.0);
  for(int i=0;i<12;i++){
    float v = inten[i]*uActive[i];
    v = pow(clamp(v*uGain[i],0.0,4.0), uGamma[i]);
    col += uColor[i]*v;
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
    for (const n of ["uTex0", "uTex1", "uTex2", "uColor", "uGain", "uGamma", "uActive"]) {
      this.loc[n] = gl.getUniformLocation(prog, n);
    }
    gl.uniform1i(this.loc.uTex0, 0);
    gl.uniform1i(this.loc.uTex1, 1);
    gl.uniform1i(this.loc.uTex2, 2);
    this.ok = true;
  }

  upload(maps: ChannelMaps) {
    const gl = this.gl;
    if (!gl) return;
    this.imgW = maps.width;
    this.imgH = maps.height;
    const px = maps.width * maps.height;
    for (const t of this.tex) gl.deleteTexture(t);
    this.tex = [];
    for (let t = 0; t < 3; t++) {
      const rgba = new Uint8Array(px * 4);
      for (let k = 0; k < 4; k++) {
        const marker = t * 4 + k;
        if (marker >= maps.maps.length || marker >= MAX_CHANNELS) break;
        const src = maps.maps[marker];
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
  }

  setChannels(chs: ChannelUniform[]) {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    gl.useProgram(this.prog);
    const colors = new Float32Array(36);
    const gain = new Float32Array(12);
    const gamma = new Float32Array(12);
    const active = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
      const ch = chs[i];
      if (ch) {
        const [r, g, b] = hexToRgb(ch.color);
        colors[i * 3] = r / 255;
        colors[i * 3 + 1] = g / 255;
        colors[i * 3 + 2] = b / 255;
        gain[i] = ch.gain;
        gamma[i] = ch.gamma;
        active[i] = ch.visible ? 1 : 0;
      }
    }
    gl.uniform3fv(this.loc.uColor, colors);
    gl.uniform1fv(this.loc.uGain, gain);
    gl.uniform1fv(this.loc.uGamma, gamma);
    gl.uniform1fv(this.loc.uActive, active);
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
