import pytest

from nanoodle_agentverse.mcp_client import (
    McpClient,
    McpError,
    PaymentRequired,
    ToolResult,
    extract_media_urls,
)

TOOLS = [
    {
        "name": "character-sprites",
        "inputSchema": {
            "type": "object",
            "properties": {"Character": {"type": "string"}},
            "required": ["Character"],
        },
    },
    {"name": "run_noodle", "inputSchema": {"type": "object", "properties": {}}},
]


def make_client(handler):
    calls = []

    def transport(url, payload, timeout):
        calls.append(payload)
        return handler(payload)

    return McpClient("https://example.invalid/mcp", transport=transport), calls


def ok_result(text, **extra):
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"content": [{"type": "text", "text": text}], **extra},
    }


def test_list_tools_and_schema():
    def handler(payload):
        return {"jsonrpc": "2.0", "id": 1, "result": {"tools": TOOLS}}

    client, _ = make_client(handler)
    assert [t["name"] for t in client.list_tools()] == ["character-sprites", "run_noodle"]
    schema = client.tool_schema("character-sprites")
    assert schema["required"] == ["Character"]
    assert client.tool_schema("nope") is None


def test_call_tool_text_and_media():
    client, calls = make_client(
        lambda payload: ok_result("done\nimage: https://host.example/out/abc.png")
    )
    outcome = client.call_tool("character-sprites", {"Character": "x"})
    assert isinstance(outcome, ToolResult)
    assert outcome.media_urls == ["https://host.example/out/abc.png"]
    assert calls[0]["params"]["name"] == "character-sprites"


def test_payment_required_from_structured_content():
    def handler(payload):
        return ok_result(
            'PAYMENT REQUIRED — deposit. Show your user ONLY this payment link:\n'
            "   https://mcp.nanoodle.com/pay/abc123\n"
            'call again with "_payment_id": "abc123"',
            structuredContent={
                "paymentId": "abc123",
                "payUrl": "https://mcp.nanoodle.com/pay/abc123",
                "watchUrl": "https://mcp.nanoodle.com/x402/watch/abc123",
            },
        )

    client, _ = make_client(handler)
    outcome = client.call_tool("character-sprites", {"Character": "x"})
    assert isinstance(outcome, PaymentRequired)
    assert outcome.pay_url == "https://mcp.nanoodle.com/pay/abc123"
    assert outcome.payment_id == "abc123"
    # the agent-only watch URL must never be the surfaced link
    assert "watch" not in outcome.pay_url


def test_payment_required_from_text_only():
    client, _ = make_client(
        lambda payload: ok_result(
            'PAYMENT REQUIRED — pay: https://mcp.nanoodle.com/pay/zz9999\n'
            '"_payment_id": "zz9999"'
        )
    )
    outcome = client.call_tool("w", {})
    assert isinstance(outcome, PaymentRequired)
    assert outcome.payment_id == "zz9999"


def test_rpc_error_is_sanitised():
    def handler(payload):
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "error": {
                "code": -32602,
                "message": "bad input see https://secret.example/?token=abc123 " + "x" * 500,
            },
        }

    client, _ = make_client(handler)
    with pytest.raises(McpError) as excinfo:
        client.call_tool("w", {})
    assert "token=abc123" not in str(excinfo.value)
    assert len(str(excinfo.value)) <= 300


def test_transport_timeout_becomes_mcp_error():
    def handler(payload):
        raise TimeoutError("slow")

    client, _ = make_client(handler)
    with pytest.raises(McpError):
        client.call_tool("w", {})


def test_extract_media_urls_filters():
    text = "see https://nanoodle.com/guide and https://h.example/out/a.mp4."
    assert extract_media_urls(text) == ["https://h.example/out/a.mp4"]
