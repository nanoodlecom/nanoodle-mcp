import pytest

from nanoodle_agentverse.parsing import (
    HelpRequest,
    ListRequest,
    PaidRequest,
    ParseError,
    RunRequest,
    StatusRequest,
    parse_message,
)

MAX = 8_000
LINK = "https://nanoodle.com/#g=abc123def"


def parse(text):
    return parse_message(text, max_input_chars=MAX)


def test_help_and_list():
    assert isinstance(parse("help"), HelpRequest)
    assert isinstance(parse("LIST"), ListRequest)


def test_run_free_text():
    cmd = parse("run character-sprites: a furnace knight")
    assert isinstance(cmd, RunRequest)
    assert cmd.tool == "character-sprites"
    assert cmd.free_text == "a furnace knight"
    assert cmd.arguments == {}


def test_run_json_inputs():
    cmd = parse('run character-sprites {"Character": "a knight", "Style": "2D"}')
    assert cmd.tool == "character-sprites"
    assert cmd.arguments == {"Character": "a knight", "Style": "2D"}
    assert cmd.free_text is None


def test_run_bad_json():
    with pytest.raises(ParseError):
        parse('run character-sprites {"Character": }')


def test_run_name_with_spaces_rejected():
    with pytest.raises(ParseError):
        parse("run my workflow: input")


def test_share_link_bare():
    cmd = parse(LINK)
    assert cmd.is_share_link
    assert cmd.share_url == LINK
    assert cmd.free_text is None


def test_share_link_with_text():
    cmd = parse(f"run {LINK} with a lighthouse at dawn")
    assert cmd.share_url == LINK
    assert cmd.free_text == "a lighthouse at dawn"


def test_share_link_with_json():
    cmd = parse(f'{LINK} {{"Idea": "a lighthouse at dawn"}}')
    assert cmd.arguments == {"Idea": "a lighthouse at dawn"}


def test_paid_and_status():
    assert parse("paid pay_123456") == PaidRequest(payment_id="pay_123456")
    assert parse("status ab12cd34ef56") == StatusRequest(job_id="ab12cd34ef56")


def test_paid_rejects_garbage():
    with pytest.raises(ParseError):
        parse("paid !!!")


def test_oversized_message_rejected():
    with pytest.raises(ParseError) as excinfo:
        parse_message("x" * 101, max_input_chars=100)
    assert "limit is 100" in str(excinfo.value)


def test_empty_and_unknown():
    with pytest.raises(ParseError):
        parse("   ")
    with pytest.raises(ParseError):
        parse("what is the weather")
