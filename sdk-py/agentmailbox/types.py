"""Dataclass mirrors of the AgentMailbox wire types."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional

Role = Literal["to", "cc", "bcc"]


@dataclass
class Message:
    id: str
    thread_id: str
    from_agent: str
    to: str
    payload: Dict[str, Any]
    context_snapshot: Dict[str, Any]
    timestamp: int
    cc: Optional[List[str]] = None
    bcc: Optional[List[str]] = None
    reply_to: Optional[str] = None


@dataclass
class ThreadSummary:
    """Structured summary produced by a Compressor on the server side.

    Available since server 0.3.0 / Python SDK 0.1.1. ``None`` on threads
    that haven't crossed the compression threshold yet, or on servers
    running an older build.
    """

    text: str
    decisions: List[str]
    open_questions: List[str]
    artifacts: Dict[str, Any]
    covers_message_ids: List[str]
    generated_at: int


@dataclass
class Context:
    snapshot: Dict[str, Any]
    thread_summary: str
    recent_messages: List[Message]
    token_count: int = 0
    thread_summary_structured: Optional["ThreadSummary"] = None


@dataclass
class ContextFrame:
    id: str
    thread_id: str
    from_agent: str
    to: str
    timestamp: int
    payload: Dict[str, Any]
    context: Context
    cc: Optional[List[str]] = None
    bcc: Optional[List[str]] = None
    reply_to: Optional[str] = None


@dataclass
class Thread:
    id: str
    participants: List[str]
    silent_participants: List[str]
    messages: List[Message]
    created_at: int
    updated_at: int


@dataclass
class ParticipantRole:
    agent_id: str
    role: Role
    joined_at: int


@dataclass
class SendResult:
    message_id: str
    thread_id: str
    delivered_to: List[str]


@dataclass
class ReceiveResult:
    messages: List[ContextFrame]
    context: Context
