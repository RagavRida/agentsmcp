"""AgentMailbox Python SDK.

Context-sync protocol for AI agents. Every agent has a mailbox.
No agent ever starts cold.
"""

from .client import AgentMailbox, AgentMailboxSync
from .exceptions import (
    AgentMailboxError,
    ConnectionError,
    NotFoundError,
    ServerError,
)
from .types import (
    Context,
    ContextFrame,
    Message,
    ParticipantRole,
    ReceiveResult,
    Role,
    SendResult,
    Thread,
    ThreadSummary,
)

__version__ = "0.1.2"

__all__ = [
    "AgentMailbox",
    "AgentMailboxSync",
    "AgentMailboxError",
    "ConnectionError",
    "NotFoundError",
    "ServerError",
    "Context",
    "ContextFrame",
    "Message",
    "ParticipantRole",
    "ReceiveResult",
    "Role",
    "SendResult",
    "Thread",
    "ThreadSummary",
    "__version__",
]
