export type Provider = "openai" | "anthropic" | "gemini";

export interface ProviderInfo {
  id: Provider;
  label: string;
  defaultModel: string;
  models: string[];
  keyHint: string;
  keysUrl: string;
}

export const PROVIDERS: Record<Provider, ProviderInfo> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    keyHint: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-3-5-haiku-latest",
    models: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-sonnet-4-20250514"],
    keyHint: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: "gemini-1.5-flash",
    models: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"],
    keyHint: "AIza…",
    keysUrl: "https://aistudio.google.com/app/apikey",
  },
};

export interface ChatMsg {
  role: "user" | "assistant" | "system";
  content: string;
}

async function errText(res: Response): Promise<string> {
  let body = "";
  try {
    body = await res.text();
    const j = JSON.parse(body);
    body = j.error?.message ?? j.error?.[0]?.message ?? j.message ?? body;
  } catch {
    /* keep raw text */
  }
  return `${res.status} ${res.statusText}${body ? ` — ${String(body).slice(0, 300)}` : ""}`;
}

/**
 * Send a chat completion directly to the chosen provider from the browser using
 * the user's own API key. No FluoroView backend is involved; keys never leave
 * the user's machine except to the provider they chose.
 */
export async function sendChat(provider: Provider, key: string, model: string, messages: ChatMsg[]): Promise<string> {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages }),
    });
    if (!res.ok) throw new Error(await errText(res));
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? "";
  }

  if (provider === "anthropic") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const msgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model, max_tokens: 1024, system: system || undefined, messages: msgs }),
    });
    if (!res.ok) throw new Error(await errText(res));
    const j = await res.json();
    return (j.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  }

  // gemini
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, systemInstruction: system ? { parts: [{ text: system }] } : undefined }),
    }
  );
  if (!res.ok) throw new Error(await errText(res));
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
}
