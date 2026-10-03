from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from ockto.activities import Activities, Event

PAYMENT_WINDOW = timedelta(hours=24)


@dataclass
class Order:
    id: str
    amount_cents: int


@workflow.defn
class OrderWorkflow:
    """An order waits up to PAYMENT_WINDOW for a `pay` signal, then expires."""

    def __init__(self) -> None:
        self.paid = False

    @workflow.signal
    def pay(self) -> None:
        self.paid = True

    @workflow.run
    async def run(self, order: Order) -> str:
        await self.emit("order.placed", order)
        try:
            await workflow.wait_condition(lambda: self.paid, timeout=PAYMENT_WINDOW)
            outcome = "paid"
        except TimeoutError:
            outcome = "expired"
        await self.emit(f"order.{outcome}", order)
        return outcome

    async def emit(self, kind: str, order: Order) -> None:
        # Key and time are fixed here in deterministic code, so every retry of
        # the activity writes the same row (see schema.sql).
        await workflow.execute_activity_method(
            Activities.record_event,
            Event(
                time=workflow.now(),
                key=f"{workflow.info().workflow_id}:{kind}",
                kind=kind,
                subject=order.id,
                payload={"amount_cents": order.amount_cents},
            ),
            start_to_close_timeout=timedelta(seconds=10),
        )
