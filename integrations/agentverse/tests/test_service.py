import asyncio
import time

import pytest

from nanoodle_agentverse.config import Config
from nanoodle_agentverse.mcp_client import McpClient
from nanoodle_agentverse.service import FacadeService
from test_mcp_client import TOOLS, ok_result

SENDER = "agent1qtesttesttest"


def make_service(handler, **config_kwargs):
    def transport(url, payload, timeout):
        return handler(payload)

    config_kwargs.setdefault("workflows", ("character-sprites",))
    config_kwargs.setdefault("short_wait_s", 5.0)
    config = Config(**config_kwargs)
    client = McpClient("https://example.invalid/mcp", transport=transport)
    return FacadeService(config, client)


def tools_handler(payload):
    return {"jsonrpc": "2.0", "id": 1, "result": {"tools": TOOLS}}


def dispatch(result_handler):
    def handler(payload):
        if payload["method"] == "tools/list":
            return tools_handler(payload)
        return result_handler(payload)

    return handler


def run(coro):
    return asyncio.run(coro)


def test_help_and_list():
    service = make_service(tools_handler)
    replies = run(service.handle_text(sender=SENDER, msg_id="m1", text="help"))
    assert "payment link" in replies[0]
    replies = run(service.handle_text(sender=SENDER, msg_id="m2", text="list"))
    assert "character-sprites" in replies[0]


def test_successful_run_resolves_free_text_key_from_schema():
    seen = {}

    def result_handler(payload):
        seen.update(payload["params"]["arguments"])
        return ok_result("made it https://h.example/out/x.png")

    service = make_service(dispatch(result_handler))
    replies = run(
        service.handle_text(
            sender=SENDER, msg_id="m3", text="run character-sprites: a knight"
        )
    )
    # free text keyed by the tool's own required string input, not a guess
    assert seen == {"Character": "a knight"}
    assert "made it" in replies[0]
    assert "Media:" in replies[0]


def test_unknown_workflow_rejected_without_calling_endpoint():
    called = []

    def result_handler(payload):
        called.append(payload)
        return ok_result("should not happen")

    service = make_service(dispatch(result_handler))
    replies = run(
        service.handle_text(sender=SENDER, msg_id="m4", text="run nope: x")
    )
    assert "don't know a workflow" in replies[0]
    assert called == []


def test_duplicate_message_replays_without_rerunning():
    runs = []

    def result_handler(payload):
        runs.append(payload)
        return ok_result("result")

    service = make_service(dispatch(result_handler))
    first = run(
        service.handle_text(sender=SENDER, msg_id="dup1", text="run character-sprites: a")
    )
    second = run(
        service.handle_text(sender=SENDER, msg_id="dup1", text="run character-sprites: a")
    )
    assert first == second
    assert len(runs) == 1


def test_paid_flow_link_then_resume():
    state = {"paid": False}

    def result_handler(payload):
        args = payload["params"]["arguments"]
        if "_payment_id" not in args:
            return ok_result(
                'PAYMENT REQUIRED — link: https://mcp.nanoodle.com/pay/p12345 '
                '"_payment_id": "p12345"',
                structuredContent={
                    "paymentId": "p12345",
                    "payUrl": "https://mcp.nanoodle.com/pay/p12345",
                    "watchUrl": "https://mcp.nanoodle.com/x402/watch/p12345",
                },
            )
        state["paid"] = True
        assert args["_payment_id"] == "p12345"
        return ok_result("paid result")

    service = make_service(dispatch(result_handler))
    replies = run(
        service.handle_text(sender=SENDER, msg_id="p1", text="run character-sprites: a")
    )
    assert "https://mcp.nanoodle.com/pay/p12345" in replies[0]
    assert "watch" not in replies[0]
    replies = run(service.handle_text(sender=SENDER, msg_id="p2", text="paid p12345"))
    assert replies == ["paid result"]
    assert state["paid"]


def test_free_preview_executes_directly_on_funded_endpoint():
    service = make_service(
        dispatch(lambda payload: ok_result("preview image https://h.example/out/p.png")),
        free_workflows=("character-sprites",),
    )
    replies = run(
        service.handle_text(sender=SENDER, msg_id="f1", text="run character-sprites: a")
    )
    assert "preview image" in replies[0]
    assert "Pay here" not in replies[0]


def test_free_preview_on_hosted_endpoint_still_returns_payment_link_with_note():
    def result_handler(payload):
        return ok_result(
            'PAYMENT REQUIRED — link: https://mcp.nanoodle.com/pay/p77777 '
            '"_payment_id": "p77777"',
            structuredContent={
                "paymentId": "p77777",
                "payUrl": "https://mcp.nanoodle.com/pay/p77777",
                "watchUrl": "https://mcp.nanoodle.com/x402/watch/p77777",
            },
        )

    service = make_service(
        dispatch(result_handler), free_workflows=("character-sprites",)
    )
    replies = run(
        service.handle_text(sender=SENDER, msg_id="f2", text="run character-sprites: a")
    )
    assert "https://mcp.nanoodle.com/pay/p77777" in replies[0]
    assert "free preview" in replies[0]
    assert "pay-per-call" in replies[0]


def test_resume_when_payment_not_settled_keeps_pending():
    calls = {"n": 0}

    def result_handler(payload):
        calls["n"] += 1
        return ok_result(
            'PAYMENT REQUIRED — link: https://mcp.nanoodle.com/pay/p31337 '
            '"_payment_id": "p31337"',
            structuredContent={
                "paymentId": "p31337",
                "payUrl": "https://mcp.nanoodle.com/pay/p31337",
                "watchUrl": "https://mcp.nanoodle.com/x402/watch/p31337",
            },
        )

    service = make_service(dispatch(result_handler))
    run(service.handle_text(sender=SENDER, msg_id="u1", text="run character-sprites: a"))
    replies = run(service.handle_text(sender=SENDER, msg_id="u2", text="paid p31337"))
    assert "has not settled yet" in replies[0]
    # pending kept: a second `paid` attempt reaches the endpoint again
    replies = run(service.handle_text(sender=SENDER, msg_id="u3", text="paid p31337"))
    assert "has not settled yet" in replies[0]
    assert calls["n"] == 3


def test_pending_payment_expires():
    import time as time_module

    from nanoodle_agentverse.service import PENDING_PAYMENT_TTL_S, _PendingPayment
    from nanoodle_agentverse.parsing import RunRequest

    service = make_service(tools_handler)
    service._pending_payments[SENDER] = _PendingPayment(
        request=RunRequest(tool="character-sprites"),
        created_at=time_module.monotonic() - PENDING_PAYMENT_TTL_S - 1,
    )
    replies = run(service.handle_text(sender=SENDER, msg_id="x1", text="paid p12345"))
    assert "expired" in replies[0]
    assert SENDER not in service._pending_payments


def test_paid_without_pending_run():
    service = make_service(tools_handler)
    replies = run(service.handle_text(sender=SENDER, msg_id="p9", text="paid p12345"))
    assert "no run waiting" in replies[0]


def test_long_run_returns_job_then_delivers():
    def slow_handler(payload):
        if payload["method"] == "tools/list":
            return tools_handler(payload)
        time.sleep(0.6)
        return ok_result("slow result")

    config = Config(workflows=("character-sprites",), short_wait_s=0.05)
    client = McpClient("https://example.invalid/mcp", transport=lambda u, p, t: slow_handler(p))
    service = FacadeService(config, client)

    async def scenario():
        replies = await service.handle_text(
            sender=SENDER, msg_id="s1", text="run character-sprites: a"
        )
        assert "background" in replies[0]
        job_id = replies[0].split("job ")[1].split(".")[0]
        status = await service.handle_text(
            sender=SENDER, msg_id="s2", text=f"status {job_id}"
        )
        assert "still running" in status[0] or "slow result" in status[0]
        await asyncio.sleep(1.0)
        finished = await service.collect_finished_jobs()
        assert finished == [(SENDER, "slow result")]
        status = await service.handle_text(
            sender=SENDER, msg_id="s3", text=f"status {job_id}"
        )
        assert status == ["slow result"]

    run(scenario())


def test_endpoint_error_is_surfaced_sanitised():
    def result_handler(payload):
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "error": {"code": -32602, "message": "unknown input https://x.example/?k=secret"},
        }

    service = make_service(dispatch(result_handler))
    replies = run(
        service.handle_text(sender=SENDER, msg_id="e1", text="run character-sprites: a")
    )
    assert "could not start" in replies[0]
    assert "secret" not in replies[0]


def test_share_link_run_uses_run_noodle_url_and_inputs():
    seen = {}

    def result_handler(payload):
        seen.update(payload["params"])
        return ok_result("linked result")

    service = make_service(dispatch(result_handler), workflows=())
    link = "https://nanoodle.com/#g=abc123"
    replies = run(
        service.handle_text(sender=SENDER, msg_id="l1", text=f"{link} with dawn lighthouse")
    )
    assert replies == ["linked result"]
    assert seen["name"] == "run_noodle"
    assert seen["arguments"]["url"] == link
    assert seen["arguments"]["inputs"] == {"Idea": "dawn lighthouse"}


def test_sweeper_skips_claimed_jobs():
    # A job a handler is actively waiting on must not also be delivered
    # by the background sweeper (double delivery of the same result).
    from nanoodle_agentverse.service import Job

    service = make_service(tools_handler)

    async def scenario():
        async def finished():
            return "done reply"

        job = Job(job_id="claimedjob1", sender=SENDER, label="w")
        job.task = asyncio.ensure_future(finished())
        job.claimed = True
        service._jobs[job.job_id] = job
        await asyncio.sleep(0.05)
        assert await service.collect_finished_jobs() == []
        job.claimed = False
        assert await service.collect_finished_jobs() == [(SENDER, "done reply")]
        # and never twice
        assert await service.collect_finished_jobs() == []

    run(scenario())


def test_natural_language_uses_default_workflow_when_configured():
    seen = {}

    def result_handler(payload):
        seen.update(payload["params"]["arguments"])
        return ok_result("nl result")

    service = make_service(
        dispatch(result_handler), default_workflow="character-sprites"
    )
    replies = run(
        service.handle_text(
            sender=SENDER, msg_id="n1", text="please draw me a furnace knight"
        )
    )
    assert replies == ["nl result"]
    assert seen == {"Character": "please draw me a furnace knight"}


def test_natural_language_without_default_workflow_gets_usage():
    service = make_service(tools_handler)
    replies = run(
        service.handle_text(sender=SENDER, msg_id="n2", text="draw me a knight")
    )
    assert "Try `list`" in replies[0]


def test_oversized_input_rejected_before_any_call():
    called = []
    service = make_service(lambda payload: called.append(payload) or tools_handler(payload))
    replies = run(
        service.handle_text(sender=SENDER, msg_id="o1", text="run character-sprites: " + "x" * 9000)
    )
    assert "limit is 8000" in replies[0]
    assert called == []
