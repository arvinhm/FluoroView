
from __future__ import annotations

import json
import urllib.request
import urllib.error
from typing import Any


PROVIDERS = {
    "OpenAI": {
        "env_var": "OPENAI_API_KEY",
        "default_model": "codex-mini-latest",
    },
    "Google Gemini": {
        "env_var": "GEMINI_API_KEY",
        "default_model": "gemini-2.5-pro-preview-05-06",
    },
    "Anthropic Claude": {
        "env_var": "ANTHROPIC_API_KEY",
        "default_model": "claude-sonnet-4-20250514",
    },
}


def _post_json(url: str, headers: dict, body: dict, timeout: int = 180) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        raise RuntimeError(f"HTTP {e.code}: {body_text[:300]}") from e


def _get_json(url: str, headers: dict | None = None, timeout: int = 30) -> Any:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        raise RuntimeError(f"HTTP {e.code}: {body_text[:300]}") from e


_OPENAI_PREFERRED_ORDER = [
    "codex-mini-latest",
    "o4-mini",
    "o3",
    "o3-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "chatgpt-4o-latest",
    "gpt-4-turbo",
    "o1",
    "o1-mini",
]

_OPENAI_KEYWORDS = (
    "codex", "gpt-5", "gpt-4", "gpt-3.5", "chatgpt",
    "o1", "o2", "o3", "o4",
)


def openai_list_models(api_key: str) -> list[str]:
    url = "https://api.openai.com/v1/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    data = _get_json(url, headers)
    all_ids = sorted(m["id"] for m in data.get("data", []))

    chat_models = [m for m in all_ids
                   if any(k in m.lower() for k in _OPENAI_KEYWORDS)]

    preferred_set = set(_OPENAI_PREFERRED_ORDER)
    top = [m for m in _OPENAI_PREFERRED_ORDER if m in chat_models]
    rest = [m for m in chat_models if m not in preferred_set]
    result = top + rest

    return result if result else all_ids[:50]


def openai_chat(api_key: str, model: str, messages: list[dict],
                system_prompt: str = "") -> str:
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    msgs = []
    if system_prompt:
        msgs.append({"role": "system", "content": system_prompt})
    msgs.extend(messages)

    is_reasoning = any(k in model for k in ("o1", "o3", "o4", "codex"))
    body: dict = {"model": model, "messages": msgs}
    if is_reasoning:
        body["max_completion_tokens"] = 16000
    else:
        body["max_tokens"] = 16000

    data = _post_json(url, headers, body)
    return data["choices"][0]["message"]["content"]


def gemini_list_models(api_key: str) -> list[str]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    data = _get_json(url)
    models = []
    for m in data.get("models", []):
        name = m.get("name", "")
        if name.startswith("models/"):
            name = name[7:]
        if "generateContent" in str(m.get("supportedGenerationMethods", [])):
            models.append(name)
    return sorted(models)


def gemini_chat(api_key: str, model: str, messages: list[dict],
                system_prompt: str = "") -> str:
    url = (f"https://generativelanguage.googleapis.com/v1beta/"
           f"models/{model}:generateContent?key={api_key}")
    headers = {"Content-Type": "application/json"}

    contents = []
    if system_prompt:
        contents.append({
            "role": "user",
            "parts": [{"text": f"[SYSTEM INSTRUCTIONS]\n{system_prompt}"}],
        })
        contents.append({
            "role": "model",
            "parts": [{"text": "Understood. I will follow those instructions."}],
        })
    for m in messages:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    body = {
        "contents": contents,
        "generationConfig": {"maxOutputTokens": 16000},
    }
    data = _post_json(url, headers, body, timeout=180)
    candidates = data.get("candidates", [])
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts)
    return "(no response)"


CLAUDE_MODELS = [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
]


def claude_list_models(api_key: str) -> list[str]:
    return list(CLAUDE_MODELS)


def claude_chat(api_key: str, model: str, messages: list[dict],
                system_prompt: str = "") -> str:
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    body: dict = {
        "model": model,
        "max_tokens": 16000,
        "messages": messages,
    }
    if system_prompt:
        body["system"] = system_prompt
    data = _post_json(url, headers, body, timeout=180)
    content = data.get("content", [])
    return "".join(b.get("text", "") for b in content if b.get("type") == "text")


def list_models(provider: str, api_key: str) -> list[str]:
    if provider == "OpenAI":
        return openai_list_models(api_key)
    elif provider == "Google Gemini":
        return gemini_list_models(api_key)
    elif provider == "Anthropic Claude":
        return claude_list_models(api_key)
    raise ValueError(f"Unknown provider: {provider}")


def chat(provider: str, api_key: str, model: str,
         messages: list[dict], system_prompt: str = "") -> str:
    if provider == "OpenAI":
        return openai_chat(api_key, model, messages, system_prompt)
    elif provider == "Google Gemini":
        return gemini_chat(api_key, model, messages, system_prompt)
    elif provider == "Anthropic Claude":
        return claude_chat(api_key, model, messages, system_prompt)
    raise ValueError(f"Unknown provider: {provider}")
