"""Wiring checks that need the pinned uAgents runtime.

Skipped automatically when uagents is not installed, so the core suite
stays dependency-free; CI for this sidecar installs requirements.txt and
runs everything.
"""

import json
from pathlib import Path

import pytest

pytest.importorskip("uagents")
pytest.importorskip("uagents_core")

from nanoodle_agentverse.config import Config, ConfigError  # noqa: E402

SEED = "iteration test seed phrase not a real wallet"


def test_build_agent_refuses_when_disabled():
    from nanoodle_agentverse.agent import build_agent

    with pytest.raises(ConfigError):
        build_agent(Config(seed=SEED))


def test_build_agent_constructs_with_chat_protocol():
    from nanoodle_agentverse.agent import build_agent

    agent = build_agent(Config(enabled=True, seed=SEED, mailbox=True))
    assert agent.name == "nanoodle"
    assert agent.address.startswith("agent1q")


def test_chat_message_shape():
    from uagents_core.contrib.protocols.chat import EndSessionContent, TextContent

    from nanoodle_agentverse.agent import _chat_message

    msg = _chat_message("hello", end_session=True)
    # defaults must fill msg_id + timezone-aware timestamp (ASI:One
    # rejects messages without them)
    assert msg.msg_id is not None
    assert msg.timestamp is not None and msg.timestamp.tzinfo is not None
    assert isinstance(msg.content[0], TextContent)
    assert isinstance(msg.content[1], EndSessionContent)
    plain = _chat_message("hi")
    assert len(plain.content) == 1


def test_committed_manifest_matches_installed_spec():
    from uagents_core.contrib.protocols.chat import chat_protocol_spec

    manifest = json.loads(
        (Path(__file__).resolve().parent.parent / "protocol-manifest.json").read_text()
    )
    assert manifest["metadata"]["name"] == chat_protocol_spec.name
    assert manifest["metadata"]["version"] == chat_protocol_spec.version


def test_register_tooling_derives_same_address():
    import register_agent
    from nanoodle_agentverse.agent import build_agent

    derived = register_agent.derive_address(SEED)
    agent = build_agent(Config(enabled=True, seed=SEED, mailbox=True))
    assert derived == agent.address
