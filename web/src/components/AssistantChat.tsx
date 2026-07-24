import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, X, Send, Settings2, Loader2, KeyRound, Circle, ExternalLink, TriangleAlert } from "lucide-react";
import { clsx } from "clsx";
import { useStore } from "../lib/store";
import { PROVIDERS, sendChat, type ChatMsg, type Provider } from "../lib/aichat";

interface AssistantState {
  open: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
}
export const useAssistant = create<AssistantState>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
}));

const ls = {
  get: (k: string, d = "") => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export default function AssistantChat() {
  const open = useAssistant((s) => s.open);
  const setOpen = useAssistant((s) => s.setOpen);

  const datasetLabel = useStore((s) => s.datasetLabel);
  const activeChannels = useStore((s) => s.activeChannels);
  const tissue = useStore((s) => s.tissue);
  const rois = useStore((s) => s.rois);

  const [provider, setProvider] = useState<Provider>(() => (ls.get("fv.ai.provider", "openai") as Provider) || "openai");
  const [model, setModel] = useState(() => ls.get(`fv.ai.model.${provider}`) || PROVIDERS[provider].defaultModel);
  const [key, setKey] = useState(() => ls.get(`fv.ai.key.${provider}`));
  const [showSettings, setShowSettings] = useState(!ls.get(`fv.ai.key.${provider}`));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setModel(ls.get(`fv.ai.model.${provider}`) || PROVIDERS[provider].defaultModel);
    setKey(ls.get(`fv.ai.key.${provider}`));
  }, [provider]);

  useEffect(() => {
    ls.set("fv.ai.provider", provider);
  }, [provider]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const saveKey = (v: string) => {
    setKey(v);
    ls.set(`fv.ai.key.${provider}`, v);
  };
  const saveModel = (v: string) => {
    setModel(v);
    ls.set(`fv.ai.model.${provider}`, v);
  };

  const systemPrompt = (): string => {
    const chNames = activeChannels.map((c) => c.name).join(", ");
    return [
      "You are FluoroView Assistant, an expert in multiplex fluorescence and H&E spatial biology helping a scientist use the FluoroView web app.",
      `Current dataset: ${datasetLabel}. Channels: ${chNames}. Cells: ${tissue ? tissue.cells.length.toLocaleString() : "n/a"}. ROIs drawn: ${rois.length}.`,
      "Give concise, practical answers. You cannot see the pixels; reason from the metadata provided. Never give medical or diagnostic advice; predictions here are experimental and not for clinical use.",
    ].join(" ");
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!key) {
      setShowSettings(true);
      return;
    }
    const next: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const reply = await sendChat(provider, key, model, [{ role: "system", content: systemPrompt() }, ...next]);
      setMessages([...next, { role: "assistant", content: reply || "(empty response)" }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages([...next, { role: "assistant", content: `⚠️ ${msg}\n\nTip: some providers block direct browser calls (CORS). Gemini generally works from the browser; OpenAI/Anthropic may require a proxy.` }]);
    } finally {
      setBusy(false);
    }
  };

  const connected = key.trim().length > 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          />
          <motion.aside
            className="fixed right-0 top-0 z-[95] flex h-full w-[min(92vw,420px)] flex-col glass-strong shadow-panel"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            role="dialog"
            aria-label="FluoroView Assistant"
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500">
                <Bot className="h-4 w-4 text-ink-950" />
              </span>
              <div className="flex-1">
                <div className="text-sm font-bold">FluoroView Assistant</div>
                <div className="flex items-center gap-1.5 text-[11px] text-white/50">
                  <Circle className={clsx("h-2 w-2", connected ? "fill-emerald-400 text-emerald-400" : "fill-amber-400 text-amber-400")} />
                  {connected ? `${PROVIDERS[provider].label} · ${model}` : "no API key"}
                </div>
              </div>
              <button onClick={() => setShowSettings((v) => !v)} className="rounded-lg p-2 text-white/60 transition hover:bg-white/10 hover:text-white" aria-label="Assistant settings">
                <Settings2 className="h-4 w-4" />
              </button>
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-white/60 transition hover:bg-white/10 hover:text-white" aria-label="Close assistant">
                <X className="h-4 w-4" />
              </button>
            </div>

            {showSettings && (
              <div className="space-y-3 border-b border-white/10 bg-white/[0.02] p-4">
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] text-white/50">
                    Provider
                    <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)} className="mt-1 w-full rounded-lg bg-white/5 px-2 py-1.5 text-sm text-white outline-none ring-1 ring-white/10">
                      {Object.values(PROVIDERS).map((p) => (
                        <option key={p.id} value={p.id} className="bg-ink-800">{p.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-white/50">
                    Model
                    <select value={model} onChange={(e) => saveModel(e.target.value)} className="mt-1 w-full rounded-lg bg-white/5 px-2 py-1.5 text-sm text-white outline-none ring-1 ring-white/10">
                      {[...new Set([model, ...PROVIDERS[provider].models])].map((m) => (
                        <option key={m} value={m} className="bg-ink-800">{m}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="block text-[11px] text-white/50">
                  <span className="inline-flex items-center gap-1"><KeyRound className="h-3 w-3" /> API key (stored only in this browser)</span>
                  <input type="password" value={key} onChange={(e) => saveKey(e.target.value)} placeholder={PROVIDERS[provider].keyHint} className="mt-1 w-full rounded-lg bg-white/5 px-2.5 py-1.5 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-cyan-400/40" />
                </label>
                <a href={PROVIDERS[provider].keysUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                  Get a {PROVIDERS[provider].label} key <ExternalLink className="h-3 w-3" />
                </a>
                <div className="flex items-start gap-1.5 rounded-lg bg-amber-400/[0.06] px-2.5 py-2 text-[10px] leading-relaxed text-amber-200/80 ring-1 ring-amber-400/20">
                  <TriangleAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  Keys are stored locally (localStorage) and sent directly from your browser to the provider. Experimental — not for clinical use.
                </div>
              </div>
            )}

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <div className="mt-6 text-center text-sm text-white/40">
                  <Bot className="mx-auto mb-2 h-8 w-8 text-white/25" />
                  Ask about your dataset, channels, phenotyping, or the workflow. It knows the current dataset context.
                </div>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={clsx("max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed", m.role === "user" ? "ml-auto bg-cyan-400/15 text-white" : "bg-white/[0.05] text-white/85")}>
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  </div>
                ))
              )}
              {busy && (
                <div className="flex items-center gap-2 text-xs text-white/40">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> thinking…
                </div>
              )}
            </div>

            <div className="border-t border-white/10 p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={1}
                  placeholder={connected ? "Message the assistant…" : "Add an API key in settings to start"}
                  className="max-h-32 min-h-[40px] flex-1 resize-none rounded-xl bg-white/5 px-3 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-cyan-400/40"
                />
                <button onClick={send} disabled={busy || !input.trim()} className="btn-primary grid h-10 w-10 place-items-center rounded-xl disabled:opacity-50" aria-label="Send message">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
