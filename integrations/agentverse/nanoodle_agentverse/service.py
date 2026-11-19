"""Orchestration between chat messages and the MCP endpoint.

Responsibilities:

- **Replay / duplicate protection.** Chat delivery is at-least-once and
  mailbox redelivery happens. A repeated ``(sender, msg_id)`` returns the
  cached reply and never re-runs a workflow — re-running would spend the
  operator's (or the caller's) money twice.
- **Free vs paid.** A run executes directly only when the MCP endpoint
  executes it — an operator-funded BYOK / free-serve endpoint, which is
  also the only place "free preview" workflows (``free_workflows``) can
  actually be free. When the endpoint answers with a payment quote, the
  caller gets the payment link and a resume instruction; this facade
  holds no wallet and pays nothing. See README.md — Agentverse has no
  native per-call settlement for external agents.
- **Long runs.** A call that outlives ``short_wait_s`` keeps running as a
  background job; the caller gets a job id immediately and the finished
  result is delivered by the agent's sweeper (or via ``status <job_id>``).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from .config import Config
from .mcp_client import McpClient, McpError, PaymentRequired, ToolResult
from .parsing import (
    HelpRequest,
    ListRequest,
    PaidRequest,
    ParseError,
    RunRequest,
    StatusRequest,
    parse_message,
)

HELP_TEXT = """\
I run Nanoodle workflows — multi-model AI pipelines built at nanoodle.com.

Send one of:
• `list` — the workflows I can run
• `run <workflow>: <your input>` — e.g. `run character-sprites: a furnace knight`
• `run <workflow> {"Input Name": "value"}` — exact inputs as JSON
• a nanoodle.com share link — runs that workflow (add `{"Idea": "..."}` or `with <text>` for inputs)
• `status <job_id>` — check a run that is finishing in the background
• `paid <payment_id>` — after paying a payment link I sent you, resume the run

Full runs are paid through Nanoodle's own payment link (Nano / NEAR / x402
rails) — I hold no wallet and cannot pay on your behalf. Workflows the
operator marked as previews run free on the operator's endpoint when it
is funded for that."""


@dataclass
class Job:
    job_id: str
    sender: str
    label: str
    task: asyncio.Task | None = None
    reply: str | None = None
    done: bool = False
    delivered: bool = False
    # True while a chat handler is actively waiting on this job within its
    # short-wait window. The delivery sweeper must skip claimed jobs, or a
    # job finishing inside the window would be delivered twice: once by
    # the sweeper, once by the handler's own reply.
    claimed: bool = False
    created_at: float = field(default_factory=time.monotonic)


# Payment quotes from nanoodle-mcp's gate expire in about 15 minutes;
# keep a small grace window for the caller's `paid` reply to arrive.
PENDING_PAYMENT_TTL_S = 20 * 60
MAX_TRACKED_JOBS = 200
MAX_CACHED_REPLIES = 1_000


@dataclass
class _PendingPayment:
    request: RunRequest
    created_at: float = field(default_factory=time.monotonic)


class FacadeService:
    def __init__(self, config: Config, client: McpClient) -> None:
        self._config = config
        self._client = client
        # (sender, msg_id) -> reply text, with insertion time for TTL.
        self._reply_cache: dict[tuple[str, str], tuple[float, str]] = {}
        self._jobs: dict[str, Job] = {}
        # sender -> the run waiting on that sender's payment.
        self._pending_payments: dict[str, _PendingPayment] = {}

    # ------------------------------------------------------------------
    # entry point used by the chat protocol handler
    # ------------------------------------------------------------------
    async def handle_text(
        self, *, sender: str, msg_id: str, text: str
    ) -> list[str]:
        """Return the reply texts for one incoming chat message.

        Usually one reply; a background job's completion is delivered
        separately through :meth:`collect_finished_jobs`.
        """
        cache_key = (sender, str(msg_id))
        cached = self._cache_get(cache_key)
        if cached is not None:
            return [cached]

        try:
            command = parse_message(text, max_input_chars=self._config.max_input_chars)
        except ParseError as exc:
            return self._cache_put(cache_key, str(exc))

        if isinstance(command, HelpRequest):
            return self._cache_put(cache_key, HELP_TEXT)
        if isinstance(command, ListRequest):
            return self._cache_put(cache_key, await self._list_reply())
        if isinstance(command, StatusRequest):
            # Status is live state, not a replayable reply — never cached.
            return [self._status_reply(command.job_id, sender)]
        if isinstance(command, PaidRequest):
            reply = await self._resume_paid(sender, command.payment_id)
            return self._cache_put(cache_key, reply)
        if isinstance(command, RunRequest):
            reply = await self._start_run(sender, command)
            return self._cache_put(cache_key, reply)
        return self._cache_put(cache_key, HELP_TEXT)  # pragma: no cover

    # ------------------------------------------------------------------
    # commands
    # ------------------------------------------------------------------
    async def _list_reply(self) -> str:
        workflows = self._config.workflows
        if not workflows:
            try:
                tools = await asyncio.to_thread(self._client.list_tools)
                workflows = tuple(
                    str(t["name"])
                    for t in tools
                    if isinstance(t.get("name"), str)
                    and t["name"] not in {"price_noodle", "noodle_guide"}
                )
            except McpError as exc:
                return f"I could not list workflows just now: {exc}"
        if not workflows:
            return (
                "No saved workflows are configured on this endpoint yet. "
                "You can still paste a nanoodle.com share link to run it."
            )
        lines = ["Workflows I can run:"]
        for name in workflows:
            marker = " (free preview)" if name in self._config.free_workflows else ""
            lines.append(f"• {name}{marker}")
        lines.append("Run one with `run <workflow>: <your input>`.")
        return "\n".join(lines)

    def _status_reply(self, job_id: str, sender: str) -> str:
        job = self._jobs.get(job_id)
        if job is None or job.sender != sender:
            return f"No job {job_id} found for you. Job ids come from runs you started here."
        if not job.done:
            return f"Job {job_id} ({job.label}) is still running."
        return job.reply or f"Job {job_id} finished without a result."

    async def _start_run(self, sender: str, request: RunRequest) -> str:
        if (
            self._config.workflows
            and not request.is_share_link
            and request.tool not in self._config.workflows
        ):
            known = ", ".join(self._config.workflows)
            return (
                f"I don't know a workflow called {request.tool!r}. "
                f"Configured workflows: {known}. Send `list` for details."
            )
        arguments = await self._build_arguments(request)
        job = Job(
            job_id=uuid.uuid4().hex[:12],
            sender=sender,
            label=request.label or request.tool,
        )
        job.task = asyncio.create_task(self._execute(sender, request, arguments))
        job.claimed = True
        self._jobs[job.job_id] = job
        self._prune_jobs()
        try:
            reply = await asyncio.wait_for(
                asyncio.shield(job.task), timeout=self._config.short_wait_s
            )
        except asyncio.TimeoutError:
            job.claimed = False
            return (
                f"Started {job.label} — it is taking a while, so it is "
                f"finishing in the background as job {job.job_id}. "
                f"Ask `status {job.job_id}` or wait here for its result."
            )
        job.done = True
        job.reply = reply
        job.delivered = True
        return reply

    async def _resume_paid(self, sender: str, payment_id: str) -> str:
        pending = self._pending_payments.get(sender)
        if pending is None:
            return (
                "I have no run waiting on a payment from you. Start one "
                "with `run <workflow>: <your input>` first — if it needs "
                "payment I will send you its payment link."
            )
        if time.monotonic() - pending.created_at > PENDING_PAYMENT_TTL_S:
            self._pending_payments.pop(sender, None)
            return (
                "That payment quote has expired (quotes live about 15 "
                "minutes). Start the run again and I will send a fresh "
                "payment link."
            )
        arguments = await self._build_arguments(pending.request)
        arguments["_payment_id"] = payment_id
        job = Job(
            job_id=uuid.uuid4().hex[:12],
            sender=sender,
            label=pending.request.label or pending.request.tool,
        )
        job.task = asyncio.create_task(
            self._execute_resumed(pending.request, arguments, sender)
        )
        job.claimed = True
        self._jobs[job.job_id] = job
        self._prune_jobs()
        try:
            reply = await asyncio.wait_for(
                asyncio.shield(job.task), timeout=self._config.short_wait_s
            )
        except asyncio.TimeoutError:
            job.claimed = False
            return (
                f"Payment noted — the run is finishing in the background "
                f"as job {job.job_id}. Ask `status {job.job_id}` or wait "
                "here for its result."
            )
        job.done = True
        job.reply = reply
        job.delivered = True
        return reply

    async def _execute_resumed(
        self, request: RunRequest, arguments: dict, sender: str
    ) -> str:
        reply, settled = await self._execute_call(
            request, arguments, sender, resumed=True
        )
        if settled:
            self._pending_payments.pop(sender, None)
        return reply

    # ------------------------------------------------------------------
    # execution
    # ------------------------------------------------------------------
    async def _build_arguments(self, request: RunRequest) -> dict:
        arguments = dict(request.arguments)
        if request.is_share_link:
            call_args: dict = {"url": request.share_url}
            inputs = dict(arguments)
            if request.free_text:
                inputs[self._config.text_input_key] = request.free_text
            if inputs:
                call_args["inputs"] = inputs
            return call_args
        if request.free_text:
            key = await self._resolve_text_key(request.tool)
            arguments[key] = request.free_text
        return arguments

    async def _resolve_text_key(self, tool: str) -> str:
        schema = await asyncio.to_thread(self._client.tool_schema, tool)
        if schema:
            properties = schema.get("properties")
            if isinstance(properties, dict) and properties:
                required = schema.get("required")
                if isinstance(required, list):
                    for name in required:
                        spec = properties.get(name)
                        if isinstance(spec, dict) and spec.get("type") == "string":
                            return str(name)
                for name, spec in properties.items():
                    if isinstance(spec, dict) and spec.get("type") == "string":
                        return str(name)
        return self._config.text_input_key

    async def _execute(
        self, sender: str, request: RunRequest, arguments: dict
    ) -> str:
        reply, _settled = await self._execute_call(
            request, arguments, sender, resumed=False
        )
        return reply

    async def _execute_call(
        self,
        request: RunRequest,
        arguments: dict,
        sender: str,
        *,
        resumed: bool,
    ) -> tuple[str, bool]:
        """Returns (reply, settled). ``settled`` is True only when a resumed
        payment actually produced a terminal outcome (result or failure),
        so the pending-payment entry can be dropped."""
        try:
            outcome = await asyncio.to_thread(
                self._client.call_tool, request.tool, arguments
            )
        except McpError as exc:
            return f"That run could not start: {exc}", resumed
        if isinstance(outcome, PaymentRequired):
            if resumed:
                return (
                    "That payment has not settled yet, or the id does not "
                    "match a paid quote. Check the payment completed, then "
                    "send `paid <payment_id>` again."
                ), False
            self._pending_payments[sender] = _PendingPayment(request=request)
            preview_note = (
                " This workflow is marked as a free preview, but the "
                "endpoint in use is pay-per-call, so it still needs the "
                "payment link for a full run."
                if request.tool in self._config.free_workflows
                else ""
            )
            id_hint = (
                f" When it is paid, reply `paid {outcome.payment_id}` and I "
                "will fetch the result."
                if outcome.payment_id
                else " When it is paid, reply `paid <payment_id>` with the id "
                "from the payment page and I will fetch the result."
            )
            return (
                f"{request.label or request.tool} runs on Nanoodle's "
                f"pay-per-call endpoint. Pay here: {outcome.pay_url}\n"
                "The price is the run's actual metered cost plus 20%; any "
                "deposit above that is refunded automatically, and a failed "
                "run is refunded too." + preview_note + id_hint
            ), False
        if outcome.is_error:
            return (
                f"That run failed: {self._trim(outcome.text or 'the workflow returned an error')}"
            ), True
        return self._format_result(request, outcome), True

    def _format_result(self, request: RunRequest, outcome: ToolResult) -> str:
        text = self._trim(outcome.text) or "(the workflow returned no text)"
        if outcome.media_urls:
            links = "\n".join(f"• {url}" for url in outcome.media_urls)
            text = f"{text}\n\nMedia:\n{links}"
        return text

    def _trim(self, text: str) -> str:
        limit = self._config.max_reply_chars
        if len(text) <= limit:
            return text
        return text[:limit] + "\n…[truncated — the full result is in the workflow's output]"

    # ------------------------------------------------------------------
    # background delivery + caches
    # ------------------------------------------------------------------
    async def collect_finished_jobs(self) -> list[tuple[str, str]]:
        """(sender, reply) pairs for jobs that finished since last check."""
        finished: list[tuple[str, str]] = []
        for job in self._jobs.values():
            if job.done or job.delivered or job.claimed:
                continue
            if job.task is not None and job.task.done():
                job.done = True
                try:
                    job.reply = job.task.result()
                except Exception:  # a crashed job must still answer its caller
                    job.reply = "That run failed unexpectedly. Please try again."
                job.delivered = True
                finished.append((job.sender, job.reply))
        return finished

    def _cache_get(self, key: tuple[str, str]) -> str | None:
        entry = self._reply_cache.get(key)
        if entry is None:
            return None
        stored_at, reply = entry
        if time.monotonic() - stored_at > self._config.dedup_ttl_s:
            self._reply_cache.pop(key, None)
            return None
        return reply

    def _cache_put(self, key: tuple[str, str], reply: str) -> list[str]:
        self._reply_cache[key] = (time.monotonic(), reply)
        if len(self._reply_cache) > MAX_CACHED_REPLIES:
            now = time.monotonic()
            expired = [
                k
                for k, (stored_at, _) in self._reply_cache.items()
                if now - stored_at > self._config.dedup_ttl_s
            ]
            for k in expired:
                self._reply_cache.pop(k, None)
            while len(self._reply_cache) > MAX_CACHED_REPLIES:
                self._reply_cache.pop(next(iter(self._reply_cache)), None)
        return [reply]

    def _prune_jobs(self) -> None:
        if len(self._jobs) <= MAX_TRACKED_JOBS:
            return
        delivered = [j for j in self._jobs.values() if j.delivered]
        for job in delivered[: len(self._jobs) - MAX_TRACKED_JOBS]:
            self._jobs.pop(job.job_id, None)
