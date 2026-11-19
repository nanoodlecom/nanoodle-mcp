"""Parse ASI:One / Agentverse chat text into facade commands.

Accepted shapes (commands are case-insensitive; workflow names are not):

    help
    list
    run <workflow>: <free-text input>
    run <workflow> {"Friendly Input Name": "value", ...}
    <nanoodle share link>
    <nanoodle share link> {"Idea": "a lighthouse at dawn"}
    run <share link> with <free-text input>
    paid <payment_id>     resume a run after paying the link it returned
    status <job_id>       check a run that is finishing in the background

Free text cannot name a workflow input by itself, so the service resolves
it against the tool's own input schema from the MCP endpoint (the first
required string input wins). If the endpoint cannot be listed, the key
falls back to ``Config.text_input_key`` (default ``Idea``, the key used in
nanoodle-mcp's own run_noodle examples). The JSON forms are the precise
route and never guess.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

SHARE_LINK_RE = re.compile(r"https://nanoodle\.com/\S*#[ga]=\S+")
PAYMENT_ID_RE = re.compile(r"^[A-Za-z0-9._\-]{6,128}$")
JOB_ID_RE = re.compile(r"^[A-Za-z0-9\-]{8,64}$")


class ParseError(ValueError):
    """The message could not be understood; the text is safe to show."""


@dataclass(frozen=True)
class HelpRequest:
    pass


@dataclass(frozen=True)
class ListRequest:
    pass


@dataclass(frozen=True)
class StatusRequest:
    job_id: str


@dataclass(frozen=True)
class PaidRequest:
    payment_id: str


@dataclass(frozen=True)
class RunRequest:
    """A workflow run.

    ``tool`` is the MCP tool name (a saved-graph tool, or ``run_noodle``
    for share links). Exactly one of ``arguments`` (explicit JSON inputs)
    or ``free_text`` (to be keyed by the service) may carry the inputs.
    """

    tool: str
    arguments: dict = field(default_factory=dict)
    free_text: str | None = None
    share_url: str | None = None
    label: str = ""

    @property
    def is_share_link(self) -> bool:
        return self.tool == "run_noodle"


Command = HelpRequest | ListRequest | StatusRequest | PaidRequest | RunRequest


def extract_share_link(text: str) -> str | None:
    match = SHARE_LINK_RE.search(text)
    return match.group(0) if match else None


def _json_object(text: str) -> dict:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ParseError(f"That JSON did not parse: {exc.msg}.") from exc
    if not isinstance(payload, dict):
        raise ParseError("Run inputs must be a JSON object.")
    return payload


def parse_message(raw_text: str, *, max_input_chars: int) -> Command:
    text = (raw_text or "").strip()
    if not text:
        raise ParseError("Send `help` to see what I can run.")
    if len(text) > max_input_chars:
        raise ParseError(
            f"That message is {len(text)} characters; the limit is "
            f"{max_input_chars}. Shorten it, or link a nanoodle workflow "
            "instead of pasting its contents."
        )

    lowered = text.lower()
    if lowered in {"help", "/help", "hi", "hello"}:
        return HelpRequest()
    if lowered in {"list", "workflows", "list workflows", "/list"}:
        return ListRequest()

    status_match = re.match(r"^status\s+(\S+)$", text, flags=re.IGNORECASE)
    if status_match:
        job_id = status_match.group(1)
        if not JOB_ID_RE.match(job_id):
            raise ParseError("That job id does not look valid.")
        return StatusRequest(job_id=job_id)

    paid_match = re.match(r"^paid\s+(\S+)$", text, flags=re.IGNORECASE)
    if paid_match:
        payment_id = paid_match.group(1)
        if not PAYMENT_ID_RE.match(payment_id):
            raise ParseError("That payment id does not look valid.")
        return PaidRequest(payment_id=payment_id)

    share_link = extract_share_link(text)
    if share_link:
        remainder = text.replace(share_link, "").strip()
        remainder = re.sub(r"^run\b", "", remainder, flags=re.IGNORECASE).strip()
        remainder = re.sub(r"^with\b", "", remainder, flags=re.IGNORECASE).strip()
        if remainder.startswith("{"):
            return RunRequest(
                tool="run_noodle",
                arguments=_json_object(remainder),
                share_url=share_link,
                label="shared workflow",
            )
        return RunRequest(
            tool="run_noodle",
            free_text=remainder or None,
            share_url=share_link,
            label="shared workflow",
        )

    run_match = re.match(r"^run\s+(.+)$", text, flags=re.IGNORECASE | re.DOTALL)
    if run_match:
        return _parse_run(run_match.group(1).strip())

    raise ParseError(
        "I run Nanoodle workflows. Try `list`, or "
        "`run <workflow>: <your input>`, or paste a nanoodle.com share link."
    )


def _parse_run(rest: str) -> RunRequest:
    if not rest:
        raise ParseError("Name a workflow: `run <workflow>: <your input>`.")
    brace = rest.find("{")
    if brace != -1:
        name = rest[:brace].strip().rstrip(":").strip()
        if not name or any(ch.isspace() for ch in name):
            raise ParseError(
                "Workflow names are single words in nanoodle-mcp. "
                "Try `list` for exact names."
            )
        return RunRequest(
            tool=name, arguments=_json_object(rest[brace:]), label=name
        )
    if ":" in rest:
        name, free_text = rest.split(":", 1)
        name = name.strip()
        free_text = free_text.strip()
        if not name or any(ch.isspace() for ch in name):
            raise ParseError(
                "Workflow names are single words in nanoodle-mcp. "
                "Try `list` for exact names."
            )
        return RunRequest(tool=name, free_text=free_text or None, label=name)
    if any(ch.isspace() for ch in rest):
        raise ParseError(
            "Use `run <workflow>: <your input>` or "
            '`run <workflow> {"Input": "value"}`.'
        )
    return RunRequest(tool=rest, label=rest)
