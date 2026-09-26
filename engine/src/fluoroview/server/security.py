"""Local-only access control for the engine.

The engine reads arbitrary files on this machine, so every request must (1) carry a Host header
naming this loopback server, which defeats DNS rebinding, and (2) for /api, present the token
generated at launch, which no other web page can know. There is deliberately no CORS: the UI is
served from the same origin.
"""

from __future__ import annotations

import hmac
from urllib.parse import parse_qs


class LocalAccessMiddleware:
    def __init__(self, app, token: str, allowed_hosts: set[str]):
        self.app = app
        self.token = token.encode()
        self.allowed_hosts = {h.lower() for h in allowed_hosts}

    async def __call__(self, scope, receive, send):
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        host = headers.get(b"host", b"").decode("latin-1").lower()
        if host not in self.allowed_hosts:
            return await self._deny(kind, receive, send, 421, "unexpected Host header")
        if scope["path"].startswith("/api/") and not self._authorized(kind, scope, headers):
            return await self._deny(kind, receive, send, 401, "missing or invalid token")
        return await self.app(scope, receive, send)

    def _authorized(self, kind: str, scope, headers) -> bool:
        presented = b""
        auth = headers.get(b"authorization", b"")
        if auth.startswith(b"Bearer "):
            presented = auth[7:].strip()
        elif kind == "websocket":
            query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
            presented = (query.get("token") or [""])[0].encode()
        return bool(presented) and hmac.compare_digest(presented, self.token)

    @staticmethod
    async def _deny(kind: str, receive, send, status: int, reason: str) -> None:
        if kind == "websocket":
            message = await receive()
            if message["type"] == "websocket.connect":
                await send({"type": "websocket.close", "code": 1008, "reason": reason})
            return
        body = reason.encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"text/plain; charset=utf-8"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
