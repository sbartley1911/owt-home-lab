-- 0006: retrieval telemetry + explicit usefulness feedback. Apply as database owner.
-- Does not alter brain_entries or the existing retrieval functions.
BEGIN;
CREATE SCHEMA rsi;
REVOKE ALL ON SCHEMA rsi FROM PUBLIC;

CREATE TABLE rsi.retrieval_requests (
  request_id text PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  caller text NOT NULL CHECK (caller <> ''),
  path text NOT NULL CHECK (path IN ('semantic_search','recent_entries','get_entry_by_id')),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object'),
  outcome text NOT NULL CHECK (outcome IN ('results','empty','error')),
  error_code text,
  CHECK ((outcome = 'error') = (error_code IS NOT NULL))
);
CREATE INDEX retrieval_requests_time ON rsi.retrieval_requests(recorded_at);
CREATE TABLE rsi.retrieval_results (
  request_id text NOT NULL REFERENCES rsi.retrieval_requests,
  rank integer NOT NULL CHECK (rank > 0),
  entry_id uuid NOT NULL,
  source_ref text,
  similarity double precision,
  rrf_score double precision,
  PRIMARY KEY (request_id, rank)
);
-- No FK to brain_entries: telemetry must survive future corpus retirement.
CREATE INDEX retrieval_results_entry ON rsi.retrieval_results(entry_id, request_id);
CREATE TABLE rsi.retrieval_feedback (
  feedback_id uuid PRIMARY KEY,
  request_id text NOT NULL REFERENCES rsi.retrieval_requests,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL,
  usefulness text NOT NULL CHECK (usefulness IN ('useful','partly_useful','not_useful')),
  reason text,
  expected_entry_id uuid
);
CREATE INDEX retrieval_feedback_request ON rsi.retrieval_feedback(request_id, recorded_at);
REVOKE ALL ON ALL TABLES IN SCHEMA rsi FROM PUBLIC;

-- Only metadata is persisted. The original result bodies are returned, never copied.
-- A repeated ID must represent the identical request and result set; otherwise fail
-- visibly instead of attributing new results to an old log row.
CREATE FUNCTION rsi.record_retrieval(
  p_id text, p_caller text, p_path text, p_args jsonb, p_results jsonb,
  p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_outcome text := CASE WHEN p_error IS NOT NULL THEN 'error'
    WHEN jsonb_array_length(p_results) = 0 THEN 'empty' ELSE 'results' END;
  v_existing rsi.retrieval_requests;
  v_rows jsonb;
BEGIN
  IF p_id IS NULL OR p_id = '' OR jsonb_typeof(p_results) IS DISTINCT FROM 'array'
     OR (p_error IS NOT NULL AND jsonb_array_length(p_results) <> 0) THEN
    RAISE EXCEPTION 'Invalid retrieval record' USING ERRCODE = '22023';
  END IF;
  -- Serialize same-ID retries before checking or inserting, with no table-wide lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id, 0));
  SELECT * INTO v_existing FROM rsi.retrieval_requests WHERE request_id = p_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'rank', n, 'entry_id', (hit->>'id')::uuid, 'source_ref', hit->>'source_ref',
    'similarity', (hit->>'similarity')::float8,
    'rrf_score', (hit->>'rrf_score')::float8) ORDER BY n), '[]'::jsonb)
  INTO v_rows FROM jsonb_array_elements(p_results) WITH ORDINALITY t(hit,n);
  IF v_existing.request_id IS NOT NULL THEN
    IF v_existing.caller IS DISTINCT FROM p_caller OR v_existing.path IS DISTINCT FROM p_path
       OR v_existing.arguments IS DISTINCT FROM p_args
       OR v_existing.outcome IS DISTINCT FROM v_outcome
       OR v_existing.error_code IS DISTINCT FROM p_error
       OR v_rows IS DISTINCT FROM (
         SELECT coalesce(jsonb_agg(to_jsonb(x) - 'request_id' ORDER BY rank),'[]'::jsonb)
         FROM rsi.retrieval_results x WHERE request_id=p_id
       ) THEN
      RAISE EXCEPTION 'Request ID reused with different data' USING ERRCODE='22023';
    END IF;
  ELSE
    INSERT INTO rsi.retrieval_requests(request_id,caller,path,arguments,outcome,error_code)
      VALUES(p_id,p_caller,p_path,p_args,v_outcome,p_error);
    INSERT INTO rsi.retrieval_results
      SELECT p_id, x.rank,x.entry_id,x.source_ref,x.similarity,x.rrf_score
      FROM jsonb_to_recordset(v_rows) x(rank int,entry_id uuid,source_ref text,
        similarity float8,rrf_score float8);
  END IF;
  RETURN jsonb_build_object('request_id',p_id,'outcome',v_outcome,
    'results',p_results,'error_code',p_error,'telemetry','recorded');
END $$;

-- Telemetry must not turn a successful read into a failed read. SQLSTATE only:
-- database error messages can contain query text or other sensitive values.
CREATE FUNCTION rsi.finish_retrieval(
  p_id text,p_caller text,p_path text,p_args jsonb,p_results jsonb,p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN rsi.record_retrieval(p_id,p_caller,p_path,p_args,p_results,p_error);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('request_id',p_id,'outcome',
    CASE WHEN p_error IS NOT NULL THEN 'error' WHEN jsonb_array_length(p_results)=0
      THEN 'empty' ELSE 'results' END,
    'results',p_results,'error_code',p_error,'telemetry','failed',
    'telemetry_error_code',SQLSTATE,
    'warning','Retrieval was not logged. Do not submit feedback for this request.');
END $$;

-- These wrappers execute retrieval with the caller's existing SELECT privileges.
-- The STABLE ranking functions stay read-only and unchanged.
CREATE FUNCTION rsi.search(
  p_id text,p_caller text,p_query text,p_embedding public.vector,
  p_count int DEFAULT 8,p_source text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_results jsonb; v_error text; v_args jsonb;
BEGIN
  v_args := jsonb_build_object('query',p_query,'count',p_count,'source',p_source,
    'retrieval_function','hybrid_brain_entries','include_history',false);
  BEGIN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'content',h.content,
      'source',h.source,'source_ref',h.source_ref,'captured_at',h.captured_at,
      'similarity',round(h.similarity::numeric,4),'rrf_score',h.rrf_score)
      ORDER BY h.ordinality),'[]'::jsonb)
    INTO v_results
    FROM public.hybrid_brain_entries(p_embedding,p_query,p_count,p_source)
      WITH ORDINALITY h;
  EXCEPTION WHEN OTHERS THEN v_results := '[]'; v_error := SQLSTATE;
  END;
  RETURN rsi.finish_retrieval(p_id,p_caller,'semantic_search',v_args,v_results,v_error);
END $$;

CREATE FUNCTION rsi.recent(p_id text,p_caller text,p_count int DEFAULT 10,
  p_include_history boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_results jsonb; v_error text;
BEGIN
  BEGIN
    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.captured_at DESC),'[]'::jsonb)
    INTO v_results FROM (
      SELECT id,status,content,source,source_ref,captured_at FROM public.brain_entries
      WHERE (p_include_history OR status <> 'superseded')
      ORDER BY captured_at DESC LIMIT p_count
    ) x;
  EXCEPTION WHEN OTHERS THEN v_results := '[]'; v_error := SQLSTATE;
  END;
  RETURN rsi.finish_retrieval(p_id,p_caller,'recent_entries',
    jsonb_build_object('count',p_count,'include_history',p_include_history),v_results,v_error);
END $$;

CREATE FUNCTION rsi.entry(p_id text,p_caller text,p_entry_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_results jsonb; v_error text;
BEGIN
  BEGIN
    SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) INTO v_results FROM (
      SELECT id,content,source,source_ref,captured_at,status,superseded_by,supersession_reason
      FROM public.brain_entries WHERE id::text=p_entry_id LIMIT 1
    ) x;
  EXCEPTION WHEN OTHERS THEN v_results := '[]'; v_error := SQLSTATE;
  END;
  RETURN rsi.finish_retrieval(p_id,p_caller,'get_entry_by_id',
    jsonb_build_object('id',p_entry_id),v_results,v_error);
END $$;

-- Endpoint identity is supplied by the fixed workflow, not an LLM argument.
-- A caller-supplied feedback UUID makes transport retries idempotent.
CREATE FUNCTION rsi.response_items(p_response jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_array_length(p_response->'results') = 0
    THEN jsonb_build_array(p_response - 'results')
    ELSE (SELECT jsonb_agg(hit || (p_response - 'results') ORDER BY n)
      FROM jsonb_array_elements(p_response->'results') WITH ORDINALITY t(hit,n)) END;
$$;

CREATE FUNCTION rsi.record_feedback(p_feedback_id uuid,p_request_id text,p_actor text,
  p_usefulness text,p_reason text DEFAULT NULL,p_expected_entry_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_existing rsi.retrieval_feedback;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rsi.retrieval_requests
    WHERE request_id=p_request_id AND caller=p_actor) THEN
    RAISE EXCEPTION 'Unknown request or caller mismatch' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_feedback_id::text, 1));
  SELECT * INTO v_existing FROM rsi.retrieval_feedback WHERE feedback_id=p_feedback_id;
  IF v_existing.feedback_id IS NOT NULL THEN
    IF (v_existing.request_id,v_existing.actor,v_existing.usefulness,
        v_existing.reason,v_existing.expected_entry_id)
      IS DISTINCT FROM (p_request_id,p_actor,p_usefulness,p_reason,p_expected_entry_id) THEN
      RAISE EXCEPTION 'Feedback ID reused with different data' USING ERRCODE='22023';
    END IF;
  ELSE
    INSERT INTO rsi.retrieval_feedback(feedback_id,request_id,actor,usefulness,reason,expected_entry_id)
      VALUES(p_feedback_id,p_request_id,p_actor,p_usefulness,p_reason,p_expected_entry_id);
  END IF;
  RETURN jsonb_build_object('feedback_id',p_feedback_id,'request_id',p_request_id,'recorded',true);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rsi FROM PUBLIC;
-- Edit this list to match the role(s) your MCP/n8n credentials connect as.
-- Existing roles get EXECUTE, never direct telemetry writes or new corpus grants.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['openbrain','openbrain_app','openbrain_mcp_ro','openbrain_mcp_rw'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA rsi TO %I',r);
      EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rsi TO %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
