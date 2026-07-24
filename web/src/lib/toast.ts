import { create } from "zustand";

export type ToastKind = "info" | "success" | "error" | "warn";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">, ttl?: number) => number;
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t, ttl) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    const life = ttl ?? (t.kind === "error" ? 6500 : 3800);
    if (life > 0 && typeof window !== "undefined") {
      window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), life);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Imperative helper usable outside React render (event handlers, async code). */
export const toast = {
  info: (title: string, message?: string) => useToasts.getState().push({ kind: "info", title, message }),
  success: (title: string, message?: string) => useToasts.getState().push({ kind: "success", title, message }),
  error: (title: string, message?: string) => useToasts.getState().push({ kind: "error", title, message }),
  warn: (title: string, message?: string) => useToasts.getState().push({ kind: "warn", title, message }),
};
