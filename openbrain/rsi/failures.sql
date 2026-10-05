-- psql -v days=7 -f failures.sql (run with a telemetry-reading administrator).
-- Unreviewed and partly-useful requests are separate from confirmed failures.
WITH report AS (
  SELECT q.request_id,q.recorded_at AT TIME ZONE 'UTC' AS recorded_utc,
    q.caller,q.path,q.arguments,q.outcome,q.error_code,
    coalesce(f.usefulness,'unreviewed') AS usefulness,f.reason,
    CASE WHEN q.outcome='error' THEN 'retrieval_error'
      WHEN q.outcome='empty' THEN 'empty_results'
      WHEN f.usefulness='not_useful' THEN 'not_useful'
      WHEN f.usefulness IS NULL THEN 'unreviewed' ELSE f.usefulness END AS category,
    coalesce((SELECT jsonb_agg(to_jsonb(r) - 'request_id' ORDER BY rank)
      FROM rsi.retrieval_results r WHERE r.request_id=q.request_id),'[]'::jsonb) AS results
  FROM rsi.retrieval_requests q
  LEFT JOIN LATERAL (SELECT usefulness,reason FROM rsi.retrieval_feedback
    WHERE request_id=q.request_id ORDER BY recorded_at DESC,feedback_id DESC LIMIT 1) f ON true
  WHERE q.recorded_at >= current_timestamp - make_interval(days => :'days'::int)
)
SELECT *,count(*) OVER () AS total_requests,
  count(*) FILTER (WHERE usefulness <> 'unreviewed') OVER () AS reviewed_requests
FROM report ORDER BY recorded_utc DESC,request_id;
