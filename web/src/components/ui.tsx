import { clsx } from "clsx";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

export function Panel({
  children,
  className,
  strong,
}: {
  children: ReactNode;
  className?: string;
  strong?: boolean;
}) {
  return (
    <div
      className={clsx(
        strong ? "glass-strong" : "glass",
        "rounded-2xl shadow-panel",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Chip({
  children,
  color,
  active,
  onClick,
  className,
}: {
  children: ReactNode;
  color?: string;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition",
        active
          ? "bg-white/12 text-white ring-1 ring-white/25"
          : "bg-white/[0.04] text-white/60 hover:text-white hover:bg-white/[0.08]",
        className
      )}
    >
      {color && (
        <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      )}
      {children}
    </button>
  );
}

export function Badge({ children, tone = "cyan" }: { children: ReactNode; tone?: "cyan" | "violet" | "amber" | "rose" }) {
  const tones: Record<string, string> = {
    cyan: "text-cyan-300 ring-cyan-400/30 bg-cyan-400/10",
    violet: "text-violet-300 ring-violet-400/30 bg-violet-400/10",
    amber: "text-amber-300 ring-amber-400/30 bg-amber-400/10",
    rose: "text-rose-300 ring-rose-400/30 bg-rose-400/10",
  };
  return (
    <span className={clsx("rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1", tones[tone])}>
      {children}
    </span>
  );
}

export function GhostButton({
  children,
  onClick,
  className,
  active,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "rounded-xl px-4 py-2 text-sm font-semibold transition hairline border",
        active
          ? "bg-white/10 text-white border-white/20"
          : "bg-white/[0.02] text-white/70 hover:text-white hover:bg-white/[0.06]",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  accent = "#22d3ee",
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  accent?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="fv-slider w-full"
      style={
        {
          background: `linear-gradient(90deg, ${accent} ${pct}%, rgba(255,255,255,0.10) ${pct}%)`,
        } as React.CSSProperties
      }
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="h-px w-8 bg-gradient-to-r from-cyan-400/70 to-transparent" />
      <span className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-300/80">{children}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "relative overflow-hidden rounded-xl bg-white/[0.04]",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-shimmer after:bg-gradient-to-r after:from-transparent after:via-white/[0.06] after:to-transparent",
        className
      )}
      aria-hidden="true"
    />
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("grid h-full min-h-[140px] place-items-center px-4 text-center", className)}>
      <div>
        {icon && <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white/5 text-white/40">{icon}</div>}
        <p className="text-sm font-semibold text-white/70">{title}</p>
        {hint && <p className="mx-auto mt-1 max-w-[260px] text-xs leading-relaxed text-white/40">{hint}</p>}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
