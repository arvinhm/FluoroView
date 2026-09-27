import { type Blend, LUT_SIZE } from "../lib/lut";
import type { Camera } from "./camera";
import { FRAGMENT, MAX_CHANNELS, VERTEX } from "./shaders";

export interface ChannelUniforms {
  /** texture layer of the channel; also its row in the colour table */
  layer: number;
  lo: number;
  hi: number;
  gamma: number;
  /** RGB for LUT_SIZE values after the window and gamma (lib/lut.ts) */
  lut: Float32Array;
  lutKey: string;
  saturation: number;
}

export interface DrawCall {
  texture: WebGLTexture;
  texSize: [number, number];
  /** world rect: x, y, w, h */
  rect: [number, number, number, number];
  /** texel rect: u, v, du, dv */
  uv: [number, number, number, number];
  smooth: boolean;
  /** 1 = opaque; below 1 while a tile fades in over its coarser fallback */
  alpha?: number;
}

/** A device-pixel rectangle with a top-left origin. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

const UNIFORMS = [
  "uRect", "uUV", "uCenter", "uScale", "uViewport", "uTex", "uLut", "uTexSize", "uCount", "uLayer", "uWindow",
  "uInvGamma", "uSaturation", "uMax", "uSmooth", "uClip", "uGrid", "uAlpha",
] as const;

type UniformName = (typeof UNIFORMS)[number];

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly loc: Record<UniformName, WebGLUniformLocation | null>;
  private readonly lut: WebGLTexture;
  /** which look each row of the colour table holds */
  private readonly lutRows: (string | null)[] = new Array<string | null>(MAX_CHANNELS).fill(null);
  private readonly lutRow = new Float32Array(LUT_SIZE * 4);
  private canvasHeight = 1;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("This browser does not support WebGL2, which FluoroView needs to draw 16-bit images.");
    this.gl = gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`shader link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.loc = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)])) as Record<
      UniformName,
      WebGLUniformLocation | null
    >;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);
    gl.uniform1i(this.loc.uTex, 0);
    gl.uniform1i(this.loc.uLut, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.lut = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, MAX_CHANNELS, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Upload a channel's colour table into its row, only when its look changed. */
  private setLutRow(row: number, key: string, rgb: Float32Array): void {
    if (this.lutRows[row] === key) return;
    const gl = this.gl;
    const data = this.lutRow;
    for (let i = 0; i < LUT_SIZE; i++) {
      data[4 * i] = rgb[3 * i]!;
      data[4 * i + 1] = rgb[3 * i + 1]!;
      data[4 * i + 2] = rgb[3 * i + 2]!;
      data[4 * i + 3] = 1;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, LUT_SIZE, 1, gl.RGBA, gl.FLOAT, data);
    gl.activeTexture(gl.TEXTURE0);
    this.lutRows[row] = key;
  }

  resize(width: number, height: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.canvasHeight = height;
  }

  clear(region?: Region, rgb: [number, number, number] = [0, 0, 0]): void {
    const gl = this.gl;
    if (region) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(region.x, this.canvasHeight - region.y - region.height, region.width, region.height);
    }
    gl.clearColor(rgb[0], rgb[1], rgb[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  setChannels(channels: ChannelUniforms[], blend: Blend = "add"): void {
    const gl = this.gl;
    const n = Math.min(channels.length, MAX_CHANNELS);
    const layer = new Int32Array(MAX_CHANNELS);
    const win = new Float32Array(2 * MAX_CHANNELS);
    const invGamma = new Float32Array(MAX_CHANNELS).fill(1);
    const sat = new Float32Array(MAX_CHANNELS).fill(1e9);
    for (let i = 0; i < n; i++) {
      const ch = channels[i]!;
      layer[i] = ch.layer;
      win[2 * i] = ch.lo;
      win[2 * i + 1] = ch.hi;
      invGamma[i] = 1 / Math.max(ch.gamma, 0.01);
      sat[i] = ch.saturation;
      if (ch.layer < MAX_CHANNELS) this.setLutRow(ch.layer, ch.lutKey, ch.lut);
    }
    gl.useProgram(this.program);
    gl.uniform1i(this.loc.uCount, n);
    gl.uniform1iv(this.loc.uLayer, layer);
    gl.uniform2fv(this.loc.uWindow, win);
    gl.uniform1fv(this.loc.uInvGamma, invGamma);
    gl.uniform1fv(this.loc.uSaturation, sat);
    gl.uniform1i(this.loc.uMax, blend === "max" ? 1 : 0);
  }

  /** Start drawing into `region` of the canvas with `camera` (scale in device px per world px). */
  begin(region: Region, camera: Camera, opts: { clip: boolean; grid: number }): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.viewport(region.x, this.canvasHeight - region.y - region.height, region.width, region.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(region.x, this.canvasHeight - region.y - region.height, region.width, region.height);
    gl.uniform2f(this.loc.uCenter, camera.cx, camera.cy);
    gl.uniform1f(this.loc.uScale, camera.scale);
    gl.uniform2f(this.loc.uViewport, region.width, region.height);
    gl.uniform1i(this.loc.uClip, opts.clip ? 1 : 0);
    gl.uniform1f(this.loc.uGrid, opts.grid);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  draw(call: DrawCall): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, call.texture);
    gl.uniform2i(this.loc.uTexSize, call.texSize[0], call.texSize[1]);
    gl.uniform4f(this.loc.uRect, ...call.rect);
    gl.uniform4f(this.loc.uUV, ...call.uv);
    gl.uniform1i(this.loc.uSmooth, call.smooth ? 1 : 0);
    gl.uniform1f(this.loc.uAlpha, call.alpha ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  end(): void {
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.disable(this.gl.BLEND);
  }
}
