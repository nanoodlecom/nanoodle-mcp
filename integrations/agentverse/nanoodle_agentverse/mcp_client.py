"""A minimal MCP streamable-HTTP client for nanoodle-mcp endpoints.

Speaks JSON-RPC 2.0 ``tools/call`` / ``tools/list`` to an operator-chosen
endpoint (the hosted ``https://mcp.nanoodle.com/mcp`` by default, or a
self-hosted ``--serve`` instance). The transport is injectable so tests
never touch the network.

Payment truth, mirrored from nanoodle-mcp's README: on the hosted
pay-per-call endpoint an unpaid ``tools/call`` does not execute — it
"hangs up" with a PAYMENT REQUIRED quote carrying a ``payUrl`` (for the
human), a ``watchUrl`` (agent-only; never shown to users) and a payment
id. After paying, the caller re-calls the same tool with the same
arguments plus ``_payment_id`` to get the results stream. This client
detects that quote shape and returns it as data; it never pays anything
itself.
"""

from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass, field
from typing import Callable

Transport = Callable[[str, dict, float], dict]

PAY_URL_RE = re.compile(r"https://[^\s\"'<>]+")
MEDIA_URL_RE = re.compile(r"https://[^\s\"'<>)\]]+")


class McpError(RuntimeError):
    """An endpoint failure whose message has been sanitised for users."""


@dataclass
class ToolResult:
    text: str
    is_error: bool = False
    media_urls: list[str] = field(default_factory=list)


@dataclass
class PaymentRequired:
    """An unpaid quote from a pay-per-call endpoint."""

    pay_url: str
    payment_id: str | None
    raw_text: str


def _default_transport(url: str, payload: dict, timeout_s: float) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return json.loads(response.read().decode("utf-8"))


def _sanitise_error(text: str, *, limit: int = 300) -> str:
    """Keep upstream errors short and free of URLs (they can carry tokens)."""
    cleaned = PAY_URL_RE.sub("[link removed]", text or "")
    cleaned = " ".join(cleaned.split())
    return cleaned[:limit] or "the endpoint returned an error"


def extract_media_urls(text: str) -> list[str]:
    urls: list[str] = []
    for url in MEDIA_URL_RE.findall(text or ""):
        url = url.rstrip(".,;")
        if any(
            marker in url
            for marker in ("/out/", "media", ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mp3", ".wav", ".glb")
        ) and url not in urls:
            urls.append(url)
    return urls


class McpClient:
    def __init__(
        self,
        url: str,
        *,
        timeout_s: float = 180.0,
        transport: Transport | None = None,
    ) -> None:
        self._url = url
        self._timeout_s = timeout_s
        self._transport = transport or _default_transport
        self._request_id = 0
        self._tools_cache: list[dict] | None = None

    def _rpc(self, method: str, params: dict) -> dict:
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
            "params": params,
        }
        try:
            response = self._transport(self._url, payload, self._timeout_s)
        except TimeoutError as exc:
            raise McpError("the Nanoodle endpoint timed out") from exc
        except Exception as exc:  # connection errors etc. — sanitise, don't leak
            raise McpError(
                f"the Nanoodle endpoint could not be reached ({type(exc).__name__})"
            ) from exc
        if not isinstance(response, dict):
            raise McpError("the Nanoodle endpoint returned a malformed response")
        if response.get("error"):
            error = response["error"]
            message = error.get("message", "") if isinstance(error, dict) else ""
            raise McpError(_sanitise_error(message))
        result = response.get("result")
        if not isinstance(result, dict):
            raise McpError("the Nanoodle endpoint returned a malformed response")
        return result

    def list_tools(self, *, refresh: bool = False) -> list[dict]:
        if self._tools_cache is None or refresh:
            result = self._rpc("tools/list", {})
            tools = result.get("tools")
            if not isinstance(tools, list):
                raise McpError("the Nanoodle endpoint returned a malformed tool list")
            self._tools_cache = [t for t in tools if isinstance(t, dict)]
        return self._tools_cache

    def tool_schema(self, name: str) -> dict | None:
        try:
            tools = self.list_tools()
        except McpError:
            return None
        for tool in tools:
            if tool.get("name") == name:
                schema = tool.get("inputSchema")
                return schema if isinstance(schema, dict) else None
        return None

    def call_tool(self, name: str, arguments: dict) -> ToolResult | PaymentRequired:
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content")
        texts: list[str] = []
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    texts.append(str(block.get("text", "")))
        text = "\n".join(texts).strip()
        structured = result.get("structuredContent")
        payment = _detect_payment_required(
            text, structured if isinstance(structured, dict) else None
        )
        if payment is not None:
            return payment
        return ToolResult(
            text=text,
            is_error=bool(result.get("isError")),
            media_urls=extract_media_urls(text),
        )


def _detect_payment_required(
    text: str, structured: dict | None = None
) -> PaymentRequired | None:
    if "PAYMENT REQUIRED" not in text and not (
        structured and isinstance(structured.get("payUrl"), str)
    ):
        return None
    pay_url: str | None = None
    payment_id: str | None = None
    # nanoodle-mcp's gate puts the quote in structuredContent.x402-shaped
    # fields: {paymentId, payUrl, watchUrl, ...}. Take payUrl/paymentId
    # from there first; the watch URL is agent-only and is never surfaced.
    if structured:
        if isinstance(structured.get("payUrl"), str):
            pay_url = structured["payUrl"]
        for key in ("paymentId", "payment_id", "id"):
            if isinstance(structured.get(key), str):
                payment_id = structured[key]
                break
    if payment_id is None:
        match = re.search(r'"_payment_id"\s*:\s*"([A-Za-z0-9._\-]{6,128})"', text)
        if match:
            payment_id = match.group(1)
    # The gate's quote is JSON in the result text; prefer parsing it so we
    # pick payUrl exactly and never surface the agent-only watchUrl.
    brace = text.find("{")
    if brace != -1:
        try:
            payload = json.loads(text[brace:])
        except (json.JSONDecodeError, ValueError):
            payload = None
        if isinstance(payload, dict):
            if isinstance(payload.get("payUrl"), str):
                pay_url = payload["payUrl"]
            for key in ("payment_id", "paymentId", "id"):
                if isinstance(payload.get(key), str):
                    payment_id = payload[key]
                    break
            next_field = payload.get("next")
            if payment_id is None and isinstance(next_field, str):
                match = re.search(r"_payment_id[\"'=:\s]+([A-Za-z0-9._\-]{6,128})", next_field)
                if match:
                    payment_id = match.group(1)
    if pay_url is None:
        # Fallback: the pay link is the one URL that is not a watch URL.
        for url in PAY_URL_RE.findall(text):
            if "/x402/watch/" not in url:
                pay_url = url.rstrip(".,;\"'")
                break
    if pay_url is None:
        return None
    return PaymentRequired(pay_url=pay_url, payment_id=payment_id, raw_text=text)
