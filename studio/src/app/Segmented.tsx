import type { CSSProperties } from "react";

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  const index = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <span className="seg" style={{ "--n": options.length, "--i": index } as CSSProperties}>
      <span className="seg-thumb" />
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </span>
  );
}
