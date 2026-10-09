-- Run in the n8n database as its owner. Exposes only the defect detector's run
-- status and timestamps to monitoring. Replace REPLACE_WITH_DETECTOR_WORKFLOW_ID
-- (two places) with your detector workflow's ID.
BEGIN;
CREATE SCHEMA IF NOT EXISTS rsi_monitoring;
REVOKE ALL ON SCHEMA rsi_monitoring FROM PUBLIC;
CREATE OR REPLACE VIEW rsi_monitoring.detector_health WITH (security_barrier=true) AS
WITH executions AS (
  SELECT id,status,"startedAt","stoppedAt"
  FROM public.execution_entity
  WHERE "workflowId"='REPLACE_WITH_DETECTOR_WORKFLOW_ID' AND mode<>'manual' AND "deletedAt" IS NULL
), latest AS (
  SELECT status FROM executions
  WHERE "stoppedAt" IS NOT NULL OR status IN ('error','crashed','canceled')
  ORDER BY id DESC LIMIT 1
)
SELECT 'REPLACE_WITH_DETECTOR_WORKFLOW_ID'::text AS workflow_id,
  COALESCE((SELECT (status IN ('error','crashed','canceled'))::int FROM latest),0) AS latest_failed,
  COALESCE(EXTRACT(EPOCH FROM max("stoppedAt") FILTER (WHERE status='success')),0)::double precision AS last_success_timestamp,
  COALESCE(EXTRACT(EPOCH FROM max(COALESCE("stoppedAt","startedAt"))
    FILTER (WHERE status IN ('error','crashed','canceled'))),0)::double precision AS last_failure_timestamp
FROM executions;
REVOKE ALL ON rsi_monitoring.detector_health FROM PUBLIC;
GRANT USAGE ON SCHEMA rsi_monitoring TO cnpg_metrics_exporter;
GRANT SELECT ON rsi_monitoring.detector_health TO cnpg_metrics_exporter;
COMMIT;
