"""Internal: JSON ↔ dataclass conversion for the AgentMailbox wire format.

The server speaks camelCase and uses ``from`` for the sender field. Python
dataclasses use snake_case and ``from_agent``. This module owns the mapping.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .types import (
    Context,
    ContextFrame,
    Message,
    ParticipantRole,
    Role,
    SendResult,
    Thread,
    ThreadSummary,
)


def _thread_summary_from_json(d: Optional[Dict[str, Any]]) -> Optional[ThreadSummary]:
    if not d:
        return None
    artifacts = d.get("artifacts")
    return ThreadSummary(
        text=str(d.get("text") or ""),
        decisions=list(d.get("decisions") or []),
        open_questions=list(d.get("openQuestions") or []),
        artifacts=dict(artifacts) if isinstance(artifacts, dict) else {},
        covers_message_ids=list(d.get("coversMessageIds") or []),
        generated_at=int(d.get("generatedAt", 0)),
    )


def message_from_json(d: Dict[str, Any]) -> Message:
    return Message(
        id=d["id"],
        thread_id=d["threadId"],
        from_agent=d["from"],
        to=d["to"],
        payload=d.get("payload"),
        context_snapshot=d.get("contextSnapshot") or {},
        timestamp=int(d["timestamp"]),
        cc=list(d["cc"]) if "cc" in d and d["cc"] is not None else None,
        bcc=list(d["bcc"]) if "bcc" in d and d["bcc"] is not None else None,
        reply_to=d.get("replyTo"),
    )


def context_from_json(d: Dict[str, Any]) -> Context:
    return Context(
        snapshot=d.get("snapshot") or {},
        thread_summary=d.get("threadSummary") or "",
        recent_messages=[message_from_json(m) for m in d.get("recentMessages") or []],
        token_count=int(d.get("tokenCount", 0)),
        thread_summary_structured=_thread_summary_from_json(
            d.get("threadSummaryStructured")
        ),
    )


def context_frame_from_json(d: Dict[str, Any]) -> ContextFrame:
    return ContextFrame(
        id=d["id"],
        thread_id=d["threadId"],
        from_agent=d["from"],
        to=d["to"],
        timestamp=int(d["timestamp"]),
        payload=d.get("payload"),
        context=context_from_json(d.get("context") or {}),
        cc=list(d["cc"]) if "cc" in d and d["cc"] is not None else None,
        bcc=list(d["bcc"]) if "bcc" in d and d["bcc"] is not None else None,
        reply_to=d.get("replyTo"),
    )


def thread_from_json(d: Dict[str, Any]) -> Thread:
    return Thread(
        id=d["id"],
        participants=list(d.get("participants") or []),
        silent_participants=list(d.get("silentParticipants") or []),
        messages=[message_from_json(m) for m in d.get("messages") or []],
        created_at=int(d["createdAt"]),
        updated_at=int(d["updatedAt"]),
    )


def participant_from_json(d: Dict[str, Any]) -> ParticipantRole:
    role: Role = d["role"]
    return ParticipantRole(
        agent_id=d["agentId"],
        role=role,
        joined_at=int(d["joinedAt"]),
    )


def send_result_from_json(d: Dict[str, Any]) -> SendResult:
    return SendResult(
        message_id=d["messageId"],
        thread_id=d["threadId"],
        delivered_to=list(d.get("deliveredTo") or []),
    )


def unread_frames_from_json(d: Dict[str, Any]) -> List[ContextFrame]:
    return [context_frame_from_json(m) for m in d.get("messages") or []]


def sync_context_from_json(d: Dict[str, Any]) -> Context:
    return context_from_json(d.get("context") or {})


def threads_from_json(d: Dict[str, Any]) -> List[Thread]:
    return [thread_from_json(t) for t in d.get("threads") or []]


def participants_from_json(d: Dict[str, Any]) -> List[ParticipantRole]:
    return [participant_from_json(p) for p in d.get("participants") or []]


def drop_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def send_body(
    from_agent: str,
    to: str,
    payload: Any,
    *,
    thread_id: Optional[str],
    context_snapshot: Optional[Dict[str, Any]],
    cc: Optional[List[str]],
    bcc: Optional[List[str]],
    reply_to: Optional[str],
) -> Dict[str, Any]:
    return drop_none(
        {
            "from": from_agent,
            "to": to,
            "payload": payload,
            "threadId": thread_id,
            "contextSnapshot": context_snapshot,
            "cc": cc,
            "bcc": bcc,
            "replyTo": reply_to,
        }
    )


def reply_all_body(
    from_agent: str,
    thread_id: str,
    payload: Any,
    *,
    context_snapshot: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    return drop_none(
        {
            "from": from_agent,
            "threadId": thread_id,
            "payload": payload,
            "contextSnapshot": context_snapshot,
        }
    )
