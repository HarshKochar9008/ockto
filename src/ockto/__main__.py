import argparse
import asyncio
import contextlib
import logging
import os

import asyncpg
import opentelemetry.trace
import sentry_sdk
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from sentry_sdk.consts import EndpointType
from sentry_sdk.integrations.otlp import OTLPIntegration
from sentry_sdk.utils import Dsn
from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy
from temporalio.contrib.opentelemetry import OpenTelemetryPlugin, create_tracer_provider
from temporalio.envconfig import ClientConfig
from temporalio.worker import Worker

from ockto.activities import Activities
from ockto.workflows import Order, OrderWorkflow

TASK_QUEUE = "ockto"


def init_telemetry(service: str) -> None:
    provider = create_tracer_provider(resource=Resource.create({"service.name": service}))
    opentelemetry.trace.set_tracer_provider(provider)
    if dsn := os.environ.get("SENTRY_DSN"):
        # Temporal needs its replay-safe provider as the global one, so Sentry's
        # OTLP integration can't install its own; point an exporter at Sentry here.
        auth = Dsn(dsn).to_auth()
        exporter = OTLPSpanExporter(
            endpoint=auth.get_api_url(EndpointType.OTLP_TRACES),
            headers={"X-Sentry-Auth": auth.to_header()},
        )
        provider.add_span_processor(BatchSpanProcessor(exporter))
        sentry_sdk.init(
            dsn=dsn,
            integrations=[OTLPIntegration(setup_otlp_traces_exporter=False, capture_exceptions=True)],
        )


async def connect() -> Client:
    # Reads TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE / TEMPORAL_API_KEY (Temporal Cloud).
    config = ClientConfig.load_client_connect_config()
    config.setdefault("target_host", "localhost:7233")
    return await Client.connect(**config, plugins=[OpenTelemetryPlugin(add_temporal_spans=True)])


async def run_worker() -> None:
    client = await connect()
    async with asyncpg.create_pool(os.environ["DATABASE_URL"]) as pool:
        worker = Worker(
            client,
            task_queue=TASK_QUEUE,
            workflows=[OrderWorkflow],
            activities=[Activities(pool).record_event],
        )
        print(f"worker polling {TASK_QUEUE!r}; waiting for orders (Ctrl+C to stop)", flush=True)
        await worker.run()


async def place_order(order_id: str, amount_cents: int) -> None:
    client = await connect()
    handle = await client.start_workflow(
        OrderWorkflow.run,
        Order(order_id, amount_cents),
        id=f"order-{order_id}",
        task_queue=TASK_QUEUE,
        id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
    )
    print(f"started {handle.id}")


async def pay(order_id: str) -> None:
    client = await connect()
    await client.get_workflow_handle(f"order-{order_id}").signal(OrderWorkflow.pay)
    print(f"paid order-{order_id}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="ockto")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("worker", help="run the Temporal worker")
    order = sub.add_parser("order", help="place an order")
    order.add_argument("id")
    order.add_argument("amount_cents", type=int)
    sub.add_parser("pay", help="mark an order as paid").add_argument("id")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    init_telemetry("ockto-worker" if args.cmd == "worker" else "ockto-cli")
    if args.cmd == "worker":
        coro = run_worker()
    elif args.cmd == "order":
        coro = place_order(args.id, args.amount_cents)
    else:
        coro = pay(args.id)
    with contextlib.suppress(KeyboardInterrupt):  # Ctrl+C = clean stop, not a traceback
        asyncio.run(coro)


if __name__ == "__main__":
    main()
