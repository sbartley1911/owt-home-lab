-- Upsert serializes concurrent claims even when the delivery row does not exist.
-- Only the winning lease is returned. Expired, unacknowledged sends are retried.
WITH batch AS (
    SELECT r.id FROM public.reports r
    LEFT JOIN public.report_email_delivery d ON d.report_id = r.id
    WHERE r.report_type = 'ingest-failure' AND d.sent_at IS NULL
      AND (d.lease_until IS NULL OR d.lease_until < now())
    ORDER BY r.created_at, r.id LIMIT 50
), claimed AS (
    INSERT INTO public.report_email_delivery (report_id, lease_token, lease_until)
    SELECT id, gen_random_uuid(), now() + interval '10 minutes' FROM batch
    ON CONFLICT (report_id) DO UPDATE
       SET lease_token = EXCLUDED.lease_token,
           lease_until = EXCLUDED.lease_until,
           attempts = report_email_delivery.attempts + 1
     WHERE report_email_delivery.sent_at IS NULL
       AND report_email_delivery.lease_until < now()
    RETURNING report_id, lease_token
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c.report_id, 'lease_token', c.lease_token,
    'created_at', r.created_at, 'synthetic', coalesce(r.meta->>'synthetic', 'false')
) ORDER BY r.created_at, r.id), '[]'::jsonb) AS reports
FROM claimed c JOIN public.reports r ON r.id = c.report_id;
