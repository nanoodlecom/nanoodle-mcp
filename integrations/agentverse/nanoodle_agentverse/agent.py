"""uAgents wiring for the Nanoodle Agentverse facade.

Implements the Agent Chat Protocol (``AgentChatProtocol`` 0.3.0, from
``uagents_core.contrib.protocols.chat``) so the agent is visible to and
usable from ASI:One Chat, and registers through Agentverse in Mailbox
mode so it stays reachable while running on the operator's own machine.

Inactive by default: :func:`build_agent` refuses to construct an agent
unless the config passes :meth:`Config.require_runnable` (explicit
enable flag + a real seed from the environment). Running this module
therefore does nothing on a fresh checkout.
"""

from __future__ import annotations

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

from .config import Config
from .mcp_client import McpClient
from .service import FacadeService


def _chat_message(text: str, *, end_session: bool = False) -> ChatMessage:
    content: list = [TextContent(type="text", text=text)]
    if end_session:
        content.append(EndSessionContent(type="end-session"))
    return ChatMessage(content=content)


def build_service(config: Config) -> FacadeService:
    client = McpClient(config.mcp_url, timeout_s=config.mcp_timeout_s)
    return FacadeService(config, client)


def build_agent(config: Config, service: FacadeService | None = None) -> Agent:
    config.require_runnable()
    facade = service or build_service(config)

    agent = Agent(
        name=config.agent_name,
        seed=config.seed,
        port=config.port,
        mailbox=config.mailbox,
        publish_agent_details=config.publish_agent_details,
    )

    protocol = Protocol(spec=chat_protocol_spec)

    @protocol.on_message(ChatMessage)
    async def handle_message(ctx: Context, sender: str, msg: ChatMessage):
        # Always acknowledge first: mailbox redelivery of an un-acked
        # message is exactly the duplicate case the service dedups.
        await ctx.send(
            sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id)
        )
        text = "".join(
            item.text for item in msg.content if isinstance(item, TextContent)
        )
        if any(isinstance(item, StartSessionContent) for item in msg.content):
            await ctx.send(
                sender,
                _chat_message(
                    "Hi — I run Nanoodle AI workflows from chat. Send "
                    "`list` to see what I can run, or paste a nanoodle.com "
                    "share link."
                ),
            )
            return
        if not text.strip():
            await ctx.send(
                sender,
                _chat_message(
                    "Send `help` to see what I can run.", end_session=True
                ),
            )
            return
        try:
            replies = await facade.handle_text(
                sender=sender, msg_id=str(msg.msg_id), text=text
            )
        except Exception:  # never leave a chat sender hanging without a reply
            ctx.logger.exception("nanoodle agentverse: handler failed")
            replies = [
                "Something went wrong on my side. Please try again in a moment."
            ]
        for reply in replies:
            await ctx.send(sender, _chat_message(reply, end_session=True))

    @protocol.on_message(ChatAcknowledgement)
    async def handle_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
        ctx.logger.debug(
            "nanoodle agentverse: ack from %s for %s",
            sender,
            msg.acknowledged_msg_id,
        )

    @agent.on_interval(period=2.0)
    async def deliver_finished_jobs(ctx: Context):
        for sender, reply in await facade.collect_finished_jobs():
            await ctx.send(sender, _chat_message(reply, end_session=True))

    agent.include(protocol, publish_manifest=True)
    return agent


def main() -> None:
    config = Config.from_env()
    agent = build_agent(config)
    agent.run()


if __name__ == "__main__":
    main()
