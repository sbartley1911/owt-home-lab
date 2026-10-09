-- 0008: document defect review queue. Additive; apply as database owner.
-- Flags only: nothing here edits, deletes, re-ingests or re-ranks brain content.
BEGIN;
CREATE TABLE rsi.defect_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scanned_at timestamptz NOT NULL,
  window_start timestamptz NOT NULL,
  request_count bigint NOT NULL,
  coverage_days numeric NOT NULL,
  finding_count integer NOT NULL DEFAULT 0
);
CREATE TABLE rsi.defect_reviews (
  source text NOT NULL,
  doc_ref text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('not_observed','short_chunks','garbled_chunks')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','resolved')),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  scan_id uuid NOT NULL REFERENCES rsi.defect_scans,
  evidence jsonb NOT NULL,
  PRIMARY KEY(source,doc_ref,reason)
);
REVOKE ALL ON rsi.defect_scans,rsi.defect_reviews FROM PUBLIC;

-- Read-only candidate generation is also the dry-run surface.
CREATE FUNCTION rsi.defect_candidates(p_as_of timestamptz DEFAULT now())
RETURNS TABLE(source text,doc_ref text,reason text,evidence jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $detector$
WITH coverage AS (
  SELECT greatest(p_as_of-interval '14 days',min(recorded_at)) AS window_start,
    count(*) FILTER (WHERE recorded_at>=p_as_of-interval '14 days') AS requests,
    extract(epoch FROM (p_as_of-greatest(p_as_of-interval '14 days',min(recorded_at))))/86400 AS days
  FROM rsi.retrieval_requests
  WHERE path='semantic_search' AND outcome IN ('results','empty') AND recorded_at<=p_as_of
), seen AS (
  SELECT DISTINCT rr.entry_id
  FROM rsi.retrieval_results rr JOIN rsi.retrieval_requests rq USING(request_id)
  WHERE rq.path='semantic_search' AND rq.outcome='results'
    AND rq.recorded_at BETWEEN p_as_of-interval '14 days' AND p_as_of
), chunks AS (
  SELECT b.id,b.source,regexp_replace(b.source_ref,'#[0-9]+$','') AS doc_ref,
    b.captured_at,b.updated_at,s.entry_id IS NOT NULL AS seen,
    btrim(CASE WHEN position(E'\n\n' in b.content)>0
      THEN substring(b.content FROM position(E'\n\n' in b.content)+2) ELSE b.content END) AS body
  FROM public.brain_entries b LEFT JOIN seen s ON s.entry_id=b.id
  WHERE b.status<>'superseded' AND b.source='consume' AND b.source_ref ~ '#[0-9]+$'
    AND b.captured_at<=p_as_of
), measures AS (
  SELECT *,length(body)<120 AS short,
    (length(body)-length(replace(body,chr(65533),''))>=3 OR
     regexp_count(body,'(Ã.|Â.|â€|ï¿½)')>=3) AS garbled
  FROM chunks
), docs AS (
  SELECT source,doc_ref,count(*) AS chunk_count,bool_or(seen) AS observed,
    max(greatest(captured_at,updated_at)) AS last_changed,
    count(*) FILTER(WHERE short) AS short_count,
    count(*) FILTER(WHERE garbled) AS garbled_count,
    (array_agg(id ORDER BY id) FILTER(WHERE short))[1:5] AS short_ids,
    (array_agg(id ORDER BY id) FILTER(WHERE garbled))[1:5] AS garbled_ids
  FROM measures GROUP BY source,doc_ref
)
SELECT d.source,d.doc_ref,r.reason,
  jsonb_build_object('detector_version',1,'chunk_count',d.chunk_count,
    'last_changed',d.last_changed,'window_start',c.window_start,'window_end',p_as_of,
    'successful_searches',c.requests,'coverage_days',c.days,
    'affected_chunks',r.affected,'sample_entry_ids',r.sample_ids,
    'interpretation','Review candidate, not proof of extraction failure; telemetry is incomplete before collection and during outages')
FROM docs d CROSS JOIN coverage c
CROSS JOIN LATERAL (VALUES
  ('not_observed',NOT d.observed AND c.requests>=20 AND c.days>=7
    AND d.last_changed<=p_as_of-interval '7 days',d.chunk_count,NULL::uuid[]),
  ('short_chunks',d.short_count>=3,d.short_count,d.short_ids),
  ('garbled_chunks',d.garbled_count>0,d.garbled_count,d.garbled_ids)
) r(reason,flag,affected,sample_ids)
WHERE r.flag;
$detector$;

CREATE FUNCTION rsi.scan_defects() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_now timestamptz:=statement_timestamp(); v_id uuid; v_count integer;
BEGIN
  -- Concurrent/retried invocations cannot race the review upserts.
  PERFORM pg_advisory_xact_lock(hashtextextended('rsi.scan_defects.v1',0));
  INSERT INTO rsi.defect_scans(scanned_at,window_start,request_count,coverage_days)
  SELECT v_now,coalesce(greatest(v_now-interval '14 days',min(recorded_at)),v_now),
    count(*) FILTER(WHERE recorded_at>=v_now-interval '14 days'),
    coalesce(extract(epoch FROM (v_now-greatest(v_now-interval '14 days',min(recorded_at))))/86400,0)
  FROM rsi.retrieval_requests WHERE path='semantic_search' AND outcome IN ('results','empty')
    AND recorded_at<=v_now RETURNING id INTO v_id;
  INSERT INTO rsi.defect_reviews(source,doc_ref,reason,first_seen,last_seen,scan_id,evidence)
  SELECT source,doc_ref,reason,v_now,v_now,v_id,evidence FROM rsi.defect_candidates(v_now)
  ON CONFLICT(source,doc_ref,reason) DO UPDATE
    SET last_seen=excluded.last_seen,scan_id=excluded.scan_id,evidence=excluded.evidence;
  -- Deliberately preserve human dispositions. Absence does not auto-resolve a finding.
  GET DIAGNOSTICS v_count=ROW_COUNT;
  UPDATE rsi.defect_scans SET finding_count=v_count WHERE id=v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION rsi.defect_candidates(timestamptz),rsi.scan_defects() FROM PUBLIC;
-- Edit this list to match the role your scheduler (n8n) connects as. It gets
-- EXECUTE on the scan only, never a new permission on brain content.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['openbrain'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA rsi TO %I',r);
      EXECUTE format('GRANT EXECUTE ON FUNCTION rsi.scan_defects() TO %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
