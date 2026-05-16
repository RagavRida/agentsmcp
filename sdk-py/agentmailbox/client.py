"""AgentMailbox Python SDK — async client and sync wrapper."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar
from urllib.parse import quote

import httpx

from . import _codec
from .exceptions import (
    AgentMailboxError,
    ConnectionError as AgentMailboxConnectionError,
    NotFoundError,
    ServerError,
)
from .types import (
    Context,
    ContextFrame,
    Message,
    ParticipantRole,
    ReceiveResult,
    SendResult,
    Thread,
)


DEFAULT_SERVER = "http://localhost:3000"
DEFAULT_TIMEOUT = 30.0

T = TypeVar("T")
Decoder = Callable[[Dict[str, Any]], T]


def _ignore(_: Dict[str, Any]) -> None:
    return None


def _raise_for_status(method: str, path: str, resp: httpx.Response) -> None:
    if resp.is_success:
        return
    body = resp.text
    msg = f"AgentMailbox {method} {path} failed: {resp.status_code} {body}"
    if resp.status_code == 404:
        raise NotFoundError(msg, status_code=resp.status_code)
    if resp.status_code >= 500:
        raise ServerError(msg, status_code=resp.status_code)
    raise AgentMailboxError(msg, status_code=resp.status_code)


class AgentMailbox:
    """Async AgentMailbox client. Talks to the AgentMailbox HTTP server."""

    def __init__(
        self,
        agent_id: str,
        server: str = DEFAULT_SERVER,
        api_key: Optional[str] = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if not agent_id:
            raise ValueError("agent_id is required")
        self.agent_id = agent_id
        self.server = server.rstrip("/")
        self.api_key = api_key
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(
            base_url=self.server, headers=headers, timeout=timeout
        )

    # --- transport ---------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        decoder: Decoder[T],
        *,
        json: Optional[Dict[str, Any]] = None,
    ) -> T:
        try:
            resp = await self._client.request(method, path, json=json)
        except httpx.ConnectError as exc:
            raise AgentMailboxConnectionError(
                f"cannot connect to AgentMailbox server at {self.server}: {exc}"
            ) from exc
        except httpx.RequestError as exc:
            raise AgentMailboxConnectionError(
                f"AgentMailbox {method} {path} request failed: {exc}"
            ) from exc
        _raise_for_status(method, path, resp)
        data = resp.json() if resp.content else {}
        return decoder(data)

    # --- lifecycle ---------------------------------------------------------

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AgentMailbox":
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[Any],
    ) -> None:
        await self.close()

    # --- protocol ----------------------------------------------------------

    async def connect(self) -> None:
        await self._request(
            "POST", "/agents/register", _ignore, json={"agentId": self.agent_id}
        )

    async def send(
        self,
        to: str,
        payload: Dict[str, Any],
        *,
        thread_id: Optional[str] = None,
        context_snapshot: Optional[Dict[str, Any]] = None,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        body = _codec.send_body(
            self.agent_id,
            to,
            payload,
            thread_id=thread_id,
            context_snapshot=context_snapshot,
            cc=cc,
            bcc=bcc,
            reply_to=reply_to,
        )
        return await self._request(
            "POST", "/messages/send", _codec.send_result_from_json, json=body
        )

    async def reply_all(
        self,
        thread_id: str,
        payload: Dict[str, Any],
        *,
        context_snapshot: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        body = _codec.reply_all_body(
            self.agent_id,
            thread_id,
            payload,
            context_snapshot=context_snapshot,
        )
        return await self._request(
            "POST", "/messages/reply-all", _codec.send_result_from_json, json=body
        )

    async def unread(self) -> List[ContextFrame]:
        path = f"/mailbox/{quote(self.agent_id, safe='')}/unread"
        return await self._request("GET", path, _codec.unread_frames_from_json)

    async def receive(self, from_agent: Optional[str] = None) -> ReceiveResult:
        frames = await self.unread()
        if from_agent is not None:
            frames = [f for f in frames if f.from_agent == from_agent]
        if frames:
            # dataclasses.replace preserves every field (including any
            # added later) instead of hand-picking — same shape-rot bug
            # that bit the JS SDK in 0.3.0–0.3.2.
            ctx = replace(frames[-1].context)
        else:
            ctx = Context(
                snapshot={}, thread_summary="", recent_messages=[], token_count=0
            )
        return ReceiveResult(messages=frames, context=ctx)

    async def sync(self, thread_id: str) -> Context:
        path = (
            f"/threads/{quote(thread_id, safe='')}/sync"
            f"?as={quote(self.agent_id, safe='')}"
        )
        return await self._request("GET", path, _codec.sync_context_from_json)

    async def threads(self) -> List[Thread]:
        path = f"/mailbox/{quote(self.agent_id, safe='')}"
        return await self._request("GET", path, _codec.threads_from_json)

    async def participants(self, thread_id: str) -> List[ParticipantRole]:
        path = (
            f"/threads/{quote(thread_id, safe='')}/participants"
            f"?as={quote(self.agent_id, safe='')}"
        )
        return await self._request("GET", path, _codec.participants_from_json)

    async def mark_read(self, thread_id: str) -> None:
        path = f"/mailbox/{quote(self.agent_id, safe='')}/read"
        await self._request("POST", path, _ignore, json={"threadId": thread_id})


class AgentMailboxSync:
    """Sync wrapper around :class:`AgentMailbox` for non-async code paths.

    Each call drives a fresh event loop with :func:`asyncio.run`. Suitable
    for scripts and notebooks; for performance-sensitive code use
    :class:`AgentMailbox` directly.
    """

    def __init__(
        self,
        agent_id: str,
        server: str = DEFAULT_SERVER,
        api_key: Optional[str] = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if not agent_id:
            raise ValueError("agent_id is required")
        self.agent_id = agent_id
        self.server = server
        self.api_key = api_key
        self.timeout = timeout

    def _new_client(self) -> AgentMailbox:
        return AgentMailbox(
            self.agent_id,
            server=self.server,
            api_key=self.api_key,
            timeout=self.timeout,
        )

    def _run(self, method: str, *args: Any, **kwargs: Any) -> Any:
        async def runner() -> Any:
            async with self._new_client() as client:
                return await getattr(client, method)(*args, **kwargs)

        return asyncio.run(runner())

    def connect(self) -> None:
        self._run("connect")

    def send(
        self,
        to: str,
        payload: Dict[str, Any],
        *,
        thread_id: Optional[str] = None,
        context_snapshot: Optional[Dict[str, Any]] = None,
        cc: Optional[List[str]] = None,
        bcc: Optional[List[str]] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        return self._run(
            "send",
            to,
            payload,
            thread_id=thread_id,
            context_snapshot=context_snapshot,
            cc=cc,
            bcc=bcc,
            reply_to=reply_to,
        )

    def reply_all(
        self,
        thread_id: str,
        payload: Dict[str, Any],
        *,
        context_snapshot: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        return self._run(
            "reply_all", thread_id, payload, context_snapshot=context_snapshot
        )

    def receive(self, from_agent: Optional[str] = None) -> ReceiveResult:
        return self._run("receive", from_agent)

    def unread(self) -> List[ContextFrame]:
        return self._run("unread")

    def sync(self, thread_id: str) -> Context:
        return self._run("sync", thread_id)

    def threads(self) -> List[Thread]:
        return self._run("threads")

    def participants(self, thread_id: str) -> List[ParticipantRole]:
        return self._run("participants", thread_id)

    def mark_read(self, thread_id: str) -> None:
        self._run("mark_read", thread_id)
