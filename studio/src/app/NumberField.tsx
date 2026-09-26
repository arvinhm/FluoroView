import { useState } from "react";
import { fmtInt } from "../lib/format";

interface Props {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  digits?: number;
  step?: number;
  min?: number;
  max?: number;
  title?: string;
}

/** Numeric entry with tabular digits: type an exact value, or step with ↑/↓ (Shift ×10). */
export function NumberField({ label, value, onCommit, digits = 0, step = 1, min = -Infinity, max = Infinity, title }: Props) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = text ?? (digits ? value.toFixed(digits) : fmtInt(value));

  const commit = () => {
    if (text === null) return;
    const v = Number.parseFloat(text.replace(/[,\s]/g, ""));
    if (Number.isFinite(v)) onCommit(clamp(digits ? v : Math.round(v)));
    setText(null);
  };

  return (
    <label className="field" title={title}>
      <span className="lab">{label}</span>
      <input
        value={shown}
        inputMode="decimal"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setText(null);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setText(null);
            onCommit(clamp(+(value + delta).toFixed(digits)));
          }
        }}
      />
    </label>
  );
}
