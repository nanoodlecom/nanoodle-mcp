import pytest

from nanoodle_agentverse.config import Config, ConfigError


def test_inactive_by_default():
    config = Config.from_env({})
    assert config.enabled is False
    with pytest.raises(ConfigError):
        config.require_runnable()


def test_placeholder_seed_rejected():
    config = Config.from_env(
        {
            "NANOODLE_AGENTVERSE_ENABLED": "1",
            "NANOODLE_AGENTVERSE_SEED": "<your-agent-seedphrase>",
        }
    )
    assert config.seed is None
    with pytest.raises(ConfigError):
        config.require_runnable()


def test_real_seed_and_enable_passes():
    config = Config.from_env(
        {
            "NANOODLE_AGENTVERSE_ENABLED": "1",
            "NANOODLE_AGENTVERSE_SEED": "word " * 11 + "word",
        }
    )
    config.require_runnable()


def test_seed_never_in_repr():
    config = Config.from_env({"NANOODLE_AGENTVERSE_SEED": "super-secret-seed"})
    assert "super-secret-seed" not in repr(config)


def test_bad_port_rejected():
    with pytest.raises(ConfigError):
        Config.from_env({"NANOODLE_AGENTVERSE_PORT": "not-a-port"})


def test_http_remote_endpoint_rejected():
    config = Config.from_env(
        {
            "NANOODLE_AGENTVERSE_ENABLED": "1",
            "NANOODLE_AGENTVERSE_SEED": "a real seed phrase here",
            "NANOODLE_MCP_URL": "http://evil.example/mcp",
        }
    )
    with pytest.raises(ConfigError):
        config.require_runnable()


def test_profile_payload_shape():
    import register_agent

    profile = register_agent.load_profile()
    payload = register_agent.build_profile_payload(
        profile, "agent1qexampleexample"
    )
    assert payload["address"] == "agent1qexampleexample"
    assert payload["name"] == profile["name"]
    assert "Nanoodle" in payload["readme"]
    assert profile["keywords"] and profile["tags"]
    plan = register_agent.registration_plan(Config.from_env({}), profile)
    assert any("FET" in line for line in plan)
