-- 0007: reports table (the ingester writes ingest-failure rows here) and a durable
-- email-delivery ledger for failure alerts. Idempotent; safe where reports already
-- exists and never rewrites historical reports.
CREATE TABLE IF NOT EXISTS public.reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_type text NOT NULL,
    title text NOT NULL,
    body_md text NOT NULL,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_type_created_idx
    ON public.reports (report_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.report_email_delivery (
    report_id uuid PRIMARY KEY REFERENCES public.reports(id) ON DELETE CASCADE,
    lease_token uuid NOT NULL,
    lease_until timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
    sent_at timestamptz,
    smtp_message_id text
);
