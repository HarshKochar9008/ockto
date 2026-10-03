import os
import uuid
from datetime import datetime, timezone

import asyncpg
import pytest
from temporalio import activity
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from ockto.activities import Activities, Event
from ockto.workflows import Order, OrderWorkflow


async def run_order(pay: bool) -> tuple[str, list[str]]:
    kinds: list[str] = []

    @activity.defn(name="record_event")
    async def record_event(event: Event) -> None:
        kinds.append(event.kind)

    async with await WorkflowEnvironment.start_time_skipping() as env:
        async with Worker(env.client, task_queue="t", workflows=[OrderWorkflow], activities=[record_event]):
            handle = await env.client.start_workflow(
                OrderWorkflow.run, Order("o1", 500), id="order-o1", task_queue="t"
            )
            if pay:
                await handle.signal(OrderWorkflow.pay)
            return await handle.result(), kinds


async def test_paid_order():
    assert await run_order(pay=True) == ("paid", ["order.placed", "order.paid"])


async def test_unpaid_order_expires():
    # Time-skipping env jumps over the 24h payment window.
    assert await run_order(pay=False) == ("expired", ["order.placed", "order.expired"])


@pytest.mark.skipif("DATABASE_URL" not in os.environ, reason="needs TimescaleDB (docker compose up)")
async def test_record_event_is_idempotent():
    event = Event(datetime.now(timezone.utc), f"test:{uuid.uuid4()}", "test", "s")
    async with asyncpg.create_pool(os.environ["DATABASE_URL"]) as pool:
        activities = Activities(pool)
        await activities.record_event(event)
        await activities.record_event(event)  # a retry
        try:
            assert await pool.fetchval("SELECT count(*) FROM events WHERE key = $1", event.key) == 1
        finally:
            await pool.execute("DELETE FROM events WHERE key = $1", event.key)
