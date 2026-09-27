import { Check } from "lucide-react";
import type { ReactNode } from "react";

export function Checkbox({ checked, onChange, disabled, title, children }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button role="checkbox" aria-checked={checked} className={`check-row${checked ? " on" : ""}`} disabled={disabled}
      title={title} onClick={() => onChange(!checked)}>
      <span className="check-box">{checked && <Check />}</span>
      <span className="check-label">{children}</span>
    </button>
  );
}
