# ockto

Temporal for orchestration, Sentry for tracing, TigerData (TimescaleDB) for the event exhaust.

`OrderWorkflow` places an order, waits up to 24h for a `pay` signal, and then records the order as `paid` or `expired`.
Each step writes an idempotent row to the `events` hypertable, tagged with its OpenTelemetry trace ID. The
`events_hourly` continuous aggregate rolls those rows up.

## Run

```sh
cp .env.example .env            # set SENTRY_DSN to ship traces + errors
docker compose up -d            # Temporal dev server (UI :8233) + TimescaleDB (:5440)
uv sync

uv run --env-file .env ockto worker
uv run --env-file .env ockto order A1 1999
uv run --env-file .env ockto pay A1
```

To point at TigerData Cloud, run `psql "$DATABASE_URL" -f schema.sql` once and set `DATABASE_URL`.
To point at Temporal Cloud, set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` and `TEMPORAL_API_KEY`.

## Test

```sh
uv run pytest                                   # workflow tests (time-skipping, no infra)
DATABASE_URL=postgresql://postgres:ockto@localhost:5440/postgres uv run pytest   # + idempotent insert
```
