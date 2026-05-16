"""Regression: structured summary must round-trip through receive() and sync()."""

from __future__ import annotations

import pytest

from agentmailbox import AgentMailbox


@pytest.mark.asyncio
async def test_sync_exposes_thread_summary_structured(agentmailbox_server: str) -> None:
    # Two participants on the same thread. Send 30 messages so that
    # older = 20 (>= default threshold) and recent = 10, triggering
    # the default NoopCompressor and the storage cache.
    async with AgentMailbox("alice@compress", server=agentmailbox_server) as alice:
        await alice.connect()
        thread_id: str | None = None
        for i in range(30):
            result = await alice.send(
                "bob@compress",
                {"n": i},
                context_snapshot={"step": f"s{i}"},
                thread_id=thread_id,
            )
            thread_id = result.thread_id

        assert thread_id is not None
        ctx = await alice.sync(thread_id)

        assert len(ctx.recent_messages) == 10
        assert ctx.token_count > 0
        assert ctx.thread_summary_structured is not None
        # NoopCompressor returns empty text but tracks coverage.
        assert len(ctx.thread_summary_structured.covers_message_ids) == 20
        assert ctx.thread_summary_structured.text == ""
        assert ctx.thread_summary_structured.decisions == []


@pytest.mark.asyncio
async def test_receive_forwards_thread_summary_structured(
    agentmailbox_server: str,
) -> None:
    async with AgentMailbox("alice@recv", server=agentmailbox_server) as alice:
        await alice.connect()
    async with AgentMailbox("bob@recv", server=agentmailbox_server) as bob:
        await bob.connect()

    async with AgentMailbox("alice@recv", server=agentmailbox_server) as alice:
        await alice.connect()
        thread_id: str | None = None
        for i in range(30):
            r = await alice.send(
                "bob@recv",
                {"n": i},
                context_snapshot={"step": f"s{i}"},
                thread_id=thread_id,
            )
            thread_id = r.thread_id

    async with AgentMailbox("bob@recv", server=agentmailbox_server) as bob:
        await bob.connect()
        rr = await bob.receive()
        # The last frame should carry the same structured summary that sync
        # would have surfaced.
        assert rr.context.thread_summary_structured is not None
        assert len(rr.context.thread_summary_structured.covers_message_ids) == 20
