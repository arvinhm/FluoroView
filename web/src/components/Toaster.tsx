import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, TriangleAlert, XCircle, X } from "lucide-react";
import { useToasts, type ToastKind } from "../lib/toast";

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warn: TriangleAlert,
  error: XCircle,
};

const TONES: Record<ToastKind, string> = {
  info: "text-cyan-300 ring-cyan-400/30",
  success: "text-emerald-300 ring-emerald-400/30",
  warn: "text-amber-300 ring-amber-400/30",
  error: "text-rose-300 ring-rose-400/30",
};

export default function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="pointer-events-auto flex items-start gap-3 rounded-2xl glass-strong px-3.5 py-3 shadow-panel"
            >
              <span className={`mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center rounded-lg ring-1 ${TONES[t.kind]}`}>
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-white">{t.title}</div>
                {t.message && <div className="mt-0.5 text-xs leading-snug text-white/60">{t.message}</div>}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-white"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
