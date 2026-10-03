import json
from dataclasses import dataclass, field
from datetime import datetime

import asyncpg
from opentelemetry import trace
from temporalio import activity


@dataclass
class Event:
    time: datetime
    key: str
    kind: str
    subject: str
    payload: dict = field(default_factory=dict)


class Activities:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    @activity.defn
    async def record_event(self, event: Event) -> None:
        # trace_id lets you jump from a row straight to its trace in Sentry.
        span = trace.get_current_span().get_span_context()
        await self.pool.execute(
            """
            INSERT INTO events (time, key, kind, subject, payload, trace_id)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            ON CONFLICT (key, time) DO NOTHING
            """,
            event.time,
            event.key,
            event.kind,
            event.subject,
            json.dumps(event.payload),
            trace.format_trace_id(span.trace_id) if span.is_valid else None,
        )
        activity.logger.info("recorded %s", event.key)
