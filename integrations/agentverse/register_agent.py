#!/usr/bin/env python3
"""Registration tooling for the Nanoodle Agentverse facade — NOT a launch.

Default mode is a dry run: it validates the environment, derives the
agent address from the seed (locally; the seed never leaves the process
and is never printed), builds the Agentverse profile payload from
``profile/profile.json``, and prints the exact registration plan.

Registration itself is an operator action (Mikkel's go): it needs an
Agentverse account/API key and an agent wallet funded with FET for the
Almanac contract registration fee/renewals. Nothing in this repository
has been registered by running the test suite or this dry run.

``--execute`` is the deliberate step: with
``NANOODLE_AGENTVERSE_REGISTER_CONFIRM=REGISTER`` set, it starts the
agent (Mailbox mode), which is the mechanism that registers on the
Almanac API/contract and publishes the chat protocol manifest. See
RUNBOOK.md before using it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nanoodle_agentverse.config import Config, ConfigError  # noqa: E402

HERE = Path(__file__).resolve().parent
PROFILE_PATH = HERE / "profile" / "profile.json"
CONFIRM_VALUE = "REGISTER"


def load_profile() -> dict:
    return json.loads(PROFILE_PATH.read_text(encoding="utf-8"))


def derive_address(seed: str) -> str:
    """Derive the agent address locally from the seed phrase."""
    from uagents_core.identity import Identity

    return Identity.from_seed(seed, 0).address


def build_profile_payload(profile: dict, address: str) -> dict:
    """The Agentverse agent-details payload for this facade.

    Mirrors the fields Agentverse uses for ASI:One ranking: name, a short
    plain-language description, readme, keywords and tags.
    """
    return {
        "address": address,
        "name": profile["name"],
        "description": profile["description"],
        "readme": (HERE / "profile" / "README.md").read_text(encoding="utf-8"),
        "keywords": profile["keywords"],
        "tags": profile["tags"],
    }


def registration_plan(config: Config, profile: dict) -> list[str]:
    return [
        "1. Create/confirm the Agentverse account that will own this agent.",
        "2. Fund the agent wallet with FET: Almanac contract registration "
        "charges a fee in FET and registrations expire and renew, so the "
        "wallet needs a small ongoing FET balance (check the current fee "
        "in the Almanac registration docs before funding).",
        "3. Export NANOODLE_AGENTVERSE_SEED from your secret store "
        "(never commit it) and NANOODLE_AGENTVERSE_ENABLED=1.",
        "4. Run with --execute (or `python -m nanoodle_agentverse.agent`): "
        "Mailbox mode registers the agent on the Almanac API, publishes "
        "the AgentChatProtocol manifest, and connects the mailbox.",
        "5. In Agentverse, open the agent profile, confirm name/handle, "
        "paste profile/README.md as the profile readme, and set the "
        "keywords/tags from profile/profile.json.",
        "6. Test from ASI:One Chat with `help`, `list`, and one preview "
        "run; check Agentverse analytics for impressions/queries — those "
        "are this experiment's success signal.",
        f"Profile name: {profile['name']}  handle suggestion: "
        f"{profile['handle_suggestion']}",
        f"MCP endpoint the agent will call: {config.mcp_url}",
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="actually start the agent and register (operator action)",
    )
    args = parser.parse_args(argv)

    config = Config.from_env()
    profile = load_profile()

    if not config.seed:
        print(
            "ERROR: NANOODLE_AGENTVERSE_SEED is not set (or is a "
            "placeholder). Registration prep needs the real seed in the "
            "environment; it is never read from a file in this repo.",
            file=sys.stderr,
        )
        return 2

    address = derive_address(config.seed)
    payload = build_profile_payload(profile, address)
    print(f"Agent address (derived locally): {address}")
    print(f"Profile payload keys: {', '.join(sorted(payload))}")
    print()
    for line in registration_plan(config, profile):
        print(line)

    if not args.execute:
        print("\nDRY RUN — nothing was registered, no wallet was created, no FET moved.")
        return 0

    if os.environ.get("NANOODLE_AGENTVERSE_REGISTER_CONFIRM") != CONFIRM_VALUE:
        print(
            "\n--execute refused: set "
            f"NANOODLE_AGENTVERSE_REGISTER_CONFIRM={CONFIRM_VALUE} to show "
            "this registration is deliberate (see RUNBOOK.md).",
            file=sys.stderr,
        )
        return 2
    try:
        config.require_runnable()
    except ConfigError as exc:
        print(f"\n--execute refused: {exc}", file=sys.stderr)
        return 2
    if not config.agentverse_api_key:
        print(
            "\nNote: AGENTVERSE_API_KEY is not set. Mailbox registration "
            "can proceed via the inspector connect flow, but scripted "
            "Agentverse API calls will not be available."
        )
    print("\nStarting agent — Almanac registration happens on startup…")
    from nanoodle_agentverse.agent import main as agent_main

    agent_main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
