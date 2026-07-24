import { LayerExtension } from "@deck.gl/core";

/**
 * Per-channel gamma for Viv image layers.
 *
 * Viv's transfer function is a *linear* ramp: `XRLayer` injects
 * `intensity = apply_contrast_limits(intensity, contrastLimits)` at the shader
 * hook `fs:DECKGL_PROCESS_INTENSITY(inout float intensity, vec2 contrastLimits,
 * int channelIndex)`. `XRLayer.getShaders()` only injects that default when
 * `_isHookDefinedByExtensions('fs:DECKGL_PROCESS_INTENSITY')` is false — so an
 * extension that defines the same hook cleanly *replaces* the linear ramp.
 *
 * This extension does exactly that: it re-applies the (inlined) linear contrast
 * mapping and then a power curve `pow(t, 1/gamma)` per channel. `gamma > 1`
 * brightens midtones, `gamma < 1` darkens (default `1.0` = identity, so nothing
 * changes until the user moves a gamma slider).
 *
 * Idiomatic for Viv 0.22 / luma.gl 9: uniforms live in a UBO module
 * (`uniformTypes` + a matching `uniform <name>Uniforms { … }` block) and are set
 * via `model.shaderInputs.setProps({ [moduleName]: … })`, mirroring
 * `ColorPaletteExtension`. `gammas` is declared in `defaultProps`, which lets the
 * deck.gl base `getSubLayerProps` forward it from the composite
 * `MultiscaleImageLayer` down to each `XRLayer` sublayer automatically.
 */

const MODULE_NAME = "fvGammaModule";

interface GammaModule {
  name: string;
  uniformTypes: Record<string, "f32">;
  fs: string;
  inject: Record<string, string>;
}

/** Build the UBO shader module for exactly `n` channels (one gamma each). */
function moduleForChannels(n: number): GammaModule {
  const count = Math.max(1, n);
  const idx = Array.from({ length: count }, (_, i) => i);
  const uniformTypes: Record<string, "f32"> = {};
  for (const i of idx) uniformTypes[`gamma${i}`] = "f32";
  const decl = idx.map((i) => `  float gamma${i};`).join("\n");
  const arr = idx.map((i) => `${MODULE_NAME}.gamma${i}`).join(", ");
  const fs = `uniform ${MODULE_NAME}Uniforms {
${decl}
} ${MODULE_NAME};

float fv_channel_gamma(int channelIndex) {
  float g[${count}] = float[${count}](${arr});
  return g[channelIndex];
}
`;
  return {
    name: MODULE_NAME,
    uniformTypes,
    fs,
    inject: {
      // Replaces XRLayer's default linear injection at the SAME hook. The hook
      // params (intensity, contrastLimits, channelIndex) are in scope here.
      "fs:DECKGL_PROCESS_INTENSITY": `
        float _fvLo = contrastLimits[0];
        float _fvHi = contrastLimits[1];
        float _fvT = max(0.0, (intensity - _fvLo) / max(0.0005, _fvHi - _fvLo));
        _fvT = clamp(_fvT, 0.0, 1.0);
        float _fvG = fv_channel_gamma(channelIndex);
        intensity = pow(_fvT, 1.0 / max(_fvG, 0.02));
      `,
    },
  };
}

/** Minimal surface of the primitive layer that deck.gl binds `this` to. */
interface GammaLayerLike {
  props: { gammas?: number[]; selections?: unknown[] };
  getNumChannels?: () => number;
  getModels: () => {
    shaderInputs: { setProps: (props: Record<string, unknown>) => void };
  }[];
}

function channelCount(layer: GammaLayerLike): number {
  return layer.props.selections?.length ?? layer.getNumChannels?.() ?? 1;
}

export default class GammaContrastExtension extends LayerExtension {
  static extensionName = "GammaContrastExtension";
  static defaultProps = {
    // Declared so deck.gl's base getSubLayerProps forwards it to sublayers.
    gammas: { type: "array" as const, value: [] as number[], compare: true },
  };

  getShaders() {
    const layer = this as unknown as GammaLayerLike;
    return { modules: [moduleForChannels(channelCount(layer))] };
  }

  updateState() {
    const layer = this as unknown as GammaLayerLike;
    const gammas = layer.props.gammas ?? [];
    const n = Math.max(1, channelCount(layer));
    const uniforms: Record<string, number> = {};
    for (let i = 0; i < n; i++) uniforms[`gamma${i}`] = gammas[i] ?? 1.0;
    for (const model of layer.getModels()) {
      model.shaderInputs.setProps({ [MODULE_NAME]: uniforms });
    }
  }
}
