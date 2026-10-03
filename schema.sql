CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Business events emitted by workflows. A hypertable's unique key must include
-- the partition column, so `time` is set by workflow.now(): every retry of the
-- same activity carries the same (key, time) and ON CONFLICT drops the duplicate.
CREATE TABLE IF NOT EXISTS events (
    time     timestamptz NOT NULL,
    key      text        NOT NULL,
    kind     text        NOT NULL,
    subject  text        NOT NULL,
    payload  jsonb       NOT NULL DEFAULT '{}',
    trace_id text,
    PRIMARY KEY (key, time)
);
SELECT create_hypertable('events', by_range('time'), if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS events_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 hour', time) AS bucket, kind, count(*) AS n
FROM events
GROUP BY bucket, kind
WITH NO DATA;

-- Refresh only re-reads invalidated ranges, so a wide start_offset is cheap and
-- catches events that land late after long activity retries.
SELECT add_continuous_aggregate_policy('events_hourly',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);
