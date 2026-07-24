import { useState } from "react";
import { Ruler } from "lucide-react";
import { useStore } from "../../lib/store";
import { toast } from "../../lib/toast";

/**
 * Pixel-size calibration control. Until the user enters microns-per-pixel the
 * viewer shows PIXELS (no fabricated physical units). Once set, the scale bar
 * and ROI areas switch to µm/mm and the value persists in the session
 * (`pixelSizeUm` is part of the exported session JSON).
 */
export function ScaleBarCalibrator() {
  const pixelSizeUm = useStore((s) => s.pixelSizeUm);
  const setPixelSizeUm = useStore((s) => s.setPixelSizeUm);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(pixelSizeUm ? String(pixelSizeUm) : "");

  const apply = () => {
    const v = parseFloat(text);
    if (!Number.isFinite(v) || v <= 0) {
      toast.error("Invalid pixel size", "Enter a positive microns-per-pixel value");
      return;
    }
    setPixelSizeUm(v);
    setOpen(false);
    toast.success("Scale calibrated", `${v} µm/px — scale bar & areas now in µm`);
  };

  const clear = () => {
    setPixelSizeUm(null);
    setText("");
    setOpen(false);
    toast.success("Calibration cleared", "Showing pixels again");
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          setText(pixelSizeUm ? String(pixelSizeUm) : "");
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 rounded-lg glass px-2.5 py-1.5 text-[11px] font-medium text-white/70 transition hover:text-white"
        title="Calibrate pixel size (µm per pixel)"
      >
        <Ruler className="h-3.5 w-3.5 text-cyan-300" />
        {pixelSizeUm ? `${pixelSizeUm} µm/px` : "Calibrate"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 left-0 z-40 w-64 rounded-xl border border-white/10 bg-ink-900/95 p-3 shadow-panel backdrop-blur-xl">
            <div className="mb-2 text-xs font-semibold text-white/80">Pixel-size calibration</div>
            <p className="mb-2 text-[11px] leading-relaxed text-white/45">
              Enter the physical size of one image pixel. The scale bar and ROI areas will use µm/mm.
            </p>
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                inputMode="decimal"
                placeholder="0.5"
                className="min-w-0 flex-1 rounded-md bg-white/[0.06] px-2 py-1.5 text-sm text-white/85 outline-none focus:bg-white/[0.1]"
              />
              <span className="text-[11px] text-white/50">µm/px</span>
              <button onClick={apply} className="rounded-md bg-cyan-400/20 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-400/30">
                Set
              </button>
            </div>
            {pixelSizeUm != null && (
              <button onClick={clear} className="mt-2 text-[11px] text-white/45 transition hover:text-rose-300">
                Clear calibration (show pixels)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
