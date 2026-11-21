"""Configuration for the Agentverse sidecar.

Everything is read from the environment. The agent seed is a secret: it is
read from ``NANOODLE_AGENTVERSE_SEED`` only, is never logged, never written
to disk by this package, and placeholder values are rejected so a copied
example can never silently become a real identity.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_MCP_URL = "https://mcp.nanoodle.com/mcp"
DEFAULT_PORT = 8001

# Values copied from documentation examples. Any of these in the seed slot
# means "not configured", never a real identity.
_PLACEHOLDER_SEEDS = {
    "",
    "your-agent-seed-phrase",
    "your_agent_seed_phrase",
    "<your-agent-seedphrase>",
    "paste_your_seed_here",
    "changeme",
    "todo",
}


class ConfigError(RuntimeError):
    """Raised when the sidecar is asked to run without safe configuration."""


def _parse_csv(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(item.strip() for item in value.split(",") if item.strip())


def _parse_bool(value: str | None, *, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_int(name: str, value: str | None, default: int, *, minimum: int) -> int:
    if value is None or value.strip() == "":
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {value!r}") from exc
    if parsed < minimum:
        raise ConfigError(f"{name} must be >= {minimum}, got {parsed}")
    return parsed


@dataclass(frozen=True)
class Config:
    """Runtime configuration. ``seed`` is excluded from repr on purpose."""

    mcp_url: str = DEFAULT_MCP_URL
    port: int = DEFAULT_PORT
    enabled: bool = False
    mailbox: bool = True
    publish_agent_details: bool = True
    agent_name: str = "nanoodle"
    seed: str | None = field(default=None, repr=False)
    agentverse_api_key: str | None = field(default=None, repr=False)
    # Saved-graph tool names this facade may run. Empty = no local allowlist;
    # the MCP endpoint then decides (its own error is surfaced, sanitised).
    workflows: tuple[str, ...] = ()
    # Workflows the operator offers as free previews. They still only run
    # when the MCP endpoint executes them without demanding payment (i.e.
    # an operator-funded BYOK / free-serve endpoint). On the hosted
    # pay-per-call endpoint they fall back to a payment deep link like
    # everything else — this facade never pays on a caller's behalf.
    free_workflows: tuple[str, ...] = ()
    # Optional: a workflow that plain natural-language messages (no
    # command prefix) are run against as free text. ASI:One routes
    # conversational prompts, and its agent tester probes with natural
    # language — without a default workflow those all bounce with usage
    # instructions. Unset by default; the operator opts in deliberately
    # because every such message spends a run.
    default_workflow: str | None = None
    # Seconds a single tools/call may take before the caller is told the
    # run is continuing in the background instead of being left hanging.
    short_wait_s: float = 10.0
    mcp_timeout_s: float = 180.0
    # Key used for free-text inputs when the endpoint's tool schema cannot
    # be consulted (notably run_noodle share links, whose inputs belong to
    # the linked graph). Matches nanoodle-mcp's own examples.
    text_input_key: str = "Idea"
    max_input_chars: int = 8_000
    max_reply_chars: int = 6_000
    dedup_ttl_s: int = 86_400  # matches nanoodle-mcp's 24h replay window

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        source = os.environ if env is None else env
        seed = source.get("NANOODLE_AGENTVERSE_SEED")
        if seed is not None:
            seed = seed.strip()
            if seed.lower() in _PLACEHOLDER_SEEDS:
                seed = None
        api_key = source.get("AGENTVERSE_API_KEY")
        if api_key is not None:
            api_key = api_key.strip() or None
        return cls(
            mcp_url=source.get("NANOODLE_MCP_URL", DEFAULT_MCP_URL).strip()
            or DEFAULT_MCP_URL,
            port=_parse_int(
                "NANOODLE_AGENTVERSE_PORT",
                source.get("NANOODLE_AGENTVERSE_PORT"),
                DEFAULT_PORT,
                minimum=1,
            ),
            enabled=_parse_bool(source.get("NANOODLE_AGENTVERSE_ENABLED")),
            mailbox=_parse_bool(
                source.get("NANOODLE_AGENTVERSE_MAILBOX"), default=True
            ),
            agent_name=source.get("NANOODLE_AGENTVERSE_NAME", "nanoodle").strip()
            or "nanoodle",
            seed=seed,
            agentverse_api_key=api_key,
            workflows=_parse_csv(source.get("NANOODLE_AGENTVERSE_WORKFLOWS")),
            free_workflows=_parse_csv(
                source.get("NANOODLE_AGENTVERSE_FREE_WORKFLOWS")
            ),
            default_workflow=(
                source.get("NANOODLE_AGENTVERSE_DEFAULT_WORKFLOW", "").strip()
                or None
            ),
            text_input_key=source.get(
                "NANOODLE_AGENTVERSE_TEXT_INPUT_KEY", "Idea"
            ).strip()
            or "Idea",
            max_input_chars=_parse_int(
                "NANOODLE_AGENTVERSE_MAX_INPUT_CHARS",
                source.get("NANOODLE_AGENTVERSE_MAX_INPUT_CHARS"),
                8_000,
                minimum=1,
            ),
            dedup_ttl_s=_parse_int(
                "NANOODLE_AGENTVERSE_DEDUP_TTL_S",
                source.get("NANOODLE_AGENTVERSE_DEDUP_TTL_S"),
                86_400,
                minimum=1,
            ),
        )

    def require_runnable(self) -> None:
        """Fail closed unless the operator deliberately enabled this facade."""
        if not self.enabled:
            raise ConfigError(
                "Agentverse facade is inactive by default. Set "
                "NANOODLE_AGENTVERSE_ENABLED=1 to run it (see RUNBOOK.md)."
            )
        if not self.seed:
            raise ConfigError(
                "NANOODLE_AGENTVERSE_SEED is not set (or is a placeholder). "
                "Generate a seed offline, keep it in your secret store, and "
                "export it — never commit it."
            )
        if not self.mcp_url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise ConfigError(
                "NANOODLE_MCP_URL must be https (or a local http endpoint)."
            )
