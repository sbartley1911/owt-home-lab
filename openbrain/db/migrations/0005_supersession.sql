-- 0005: supersession schema + retrieval filter + absence-claim guard + provenance.
-- Additive only: a retired memory is marked, never deleted. Single transaction.
--
-- Retrieval (match_brain_entries / hybrid_brain_entries / recent entries) hides
-- superseded rows unless include_history is true. supersede_brain_entry() is the
-- only intended write path for the mark; it needs UPDATE on brain_entries, so run
-- it as the database owner (the optional append-only openbrain_app role from 0001
-- deliberately has no UPDATE).
--
-- The capture guard rejects inserts that assert a negative existence claim
-- ("there is no record of ...") unless tagged [verified-absence], and stamps a
-- provenance class on every non-ingested row. Tune or drop the trigger if that
-- policy doesn't fit your use.

BEGIN;

-- 1) Schema marks --------------------------------------------------------------
ALTER TABLE public.brain_entries
  ADD COLUMN status text NOT NULL DEFAULT 'live',
  ADD COLUMN superseded_by uuid REFERENCES public.brain_entries(id),
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN supersession_reason text,
  ADD COLUMN entry_class text,
  ADD COLUMN provenance text;

ALTER TABLE public.brain_entries
  ADD CONSTRAINT brain_entries_status_check
    CHECK (status IN ('live','verified','stale','contradicted','superseded')),
  ADD CONSTRAINT brain_entries_entry_class_check
    CHECK (entry_class IS NULL OR entry_class IN ('operational','durable')),
  ADD CONSTRAINT brain_entries_provenance_check
    CHECK (provenance IS NULL OR provenance IN ('measured','inferred','asserted','ingested')),
  ADD CONSTRAINT brain_entries_supersession_consistency
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  ADD CONSTRAINT brain_entries_no_self_supersession
    CHECK (superseded_by IS NULL OR superseded_by <> id);

CREATE INDEX brain_entries_status_nonlive_idx
  ON public.brain_entries (status) WHERE status <> 'live';

-- 2) The mark: supersede, never delete ----------------------------------------
CREATE FUNCTION public.supersede_brain_entry(old_id uuid, new_id uuid, reason text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE r jsonb;
BEGIN
  IF old_id = new_id THEN
    RAISE EXCEPTION 'an entry cannot supersede itself';
  END IF;
  IF coalesce(btrim(reason), '') = '' THEN
    RAISE EXCEPTION 'a supersession reason is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.brain_entries WHERE public.brain_entries.id = new_id) THEN
    RAISE EXCEPTION 'successor entry % does not exist', new_id;
  END IF;
  UPDATE public.brain_entries
     SET status = 'superseded',
         superseded_by = new_id,
         superseded_at = now(),
         supersession_reason = reason
   WHERE public.brain_entries.id = old_id
     AND public.brain_entries.status <> 'superseded'
  RETURNING jsonb_build_object(
      'id', brain_entries.id,
      'status', brain_entries.status,
      'superseded_by', brain_entries.superseded_by,
      'superseded_at', brain_entries.superseded_at,
      'reason', brain_entries.supersession_reason)
    INTO r;
  IF r IS NULL THEN
    RAISE EXCEPTION 'entry % not found or already superseded', old_id;
  END IF;
  RETURN r;
END
$fn$;

-- 3) Absence-claim guard + provenance stamping (every write path) --------------
CREATE FUNCTION public.guard_brain_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE hit text;
BEGIN
  -- Ingested documents are records, not agent assertions.
  IF NEW.source = 'consume' OR NEW.entry_type = 'document' THEN
    IF NEW.provenance IS NULL THEN NEW.provenance := 'ingested'; END IF;
    RETURN NEW;
  END IF;
  -- Search-backed negatives pass only with the explicit tag.
  IF NEW.content !~* '\[verified-absence\]' THEN
    hit := substring(NEW.content from '(?i)(nothing is (recorded|documented|stored)|there is no record of|no (recorded )?(justification|record|entry|ticket|documentation)[a-z ]{0,25}(exists|anywhere)|was never (built|installed|deployed|created|recorded|documented|configured|wired)|never existed|not (recorded|documented|tracked) anywhere|nowhere in the (brain|corpus|repo|estate))');
    IF hit IS NOT NULL THEN
      RAISE EXCEPTION 'absence-claim guard: capture asserts a negative existence claim ("%"). A negative is a search trigger, not a conclusion. Search first; a search-verified absence must state what was searched and carry the tag [verified-absence] in the content.', hit;
    END IF;
  END IF;
  IF NEW.provenance IS NULL THEN
    NEW.provenance := CASE
      WHEN NEW.content ~* '\[measured\]' THEN 'measured'
      WHEN NEW.content ~* '\[inferred\]' THEN 'inferred'
      ELSE 'asserted'
    END;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER brain_entries_capture_guard
  BEFORE INSERT ON public.brain_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_brain_capture();

-- 4) Retrieval honors the marks -------------------------------------------------
-- Signature change (new trailing defaulted params) requires DROP+CREATE in one
-- transaction; CREATE OR REPLACE would leave an ambiguous overload.
DROP FUNCTION public.hybrid_brain_entries(vector, text, integer, text, timestamp with time zone);

CREATE FUNCTION public.hybrid_brain_entries(
  query_embedding vector,
  query_text text,
  match_count integer DEFAULT 8,
  source_filter text DEFAULT NULL::text,
  since timestamp with time zone DEFAULT NULL::timestamp with time zone,
  include_history boolean DEFAULT false,
  provenance_filter text DEFAULT NULL::text)
RETURNS TABLE(id uuid, content text, source text, source_ref text, metadata jsonb,
              people text[], topics text[], entry_type text,
              captured_at timestamp with time zone,
              similarity double precision, rrf_score double precision,
              status text, superseded_by uuid)
LANGUAGE sql
STABLE
AS $fn$
  with params as (
    select greatest(least(coalesce(match_count, 8), 50), 1) as k,
           greatest(least(coalesce(match_count, 8), 50) * 3, 20) as fetch_n
  ),
  vec as (
    select be.id,
           row_number() over (order by be.embedding <=> query_embedding) as rank,
           1 - (be.embedding <=> query_embedding) as sim
    from public.brain_entries be, params
    where (source_filter is null or be.source = source_filter)
      and (since is null or be.captured_at >= since)
      and (include_history or be.status <> 'superseded')
      and (provenance_filter is null or be.provenance = provenance_filter)
    order by be.embedding <=> query_embedding
    limit (select fetch_n from params)
  ),
  fts as (
    select be.id,
           row_number() over (
             order by ts_rank(be.content_search, plainto_tsquery('english', query_text)) desc
           ) as rank
    from public.brain_entries be, params
    where be.content_search @@ plainto_tsquery('english', query_text)
      and (source_filter is null or be.source = source_filter)
      and (since is null or be.captured_at >= since)
      and (include_history or be.status <> 'superseded')
      and (provenance_filter is null or be.provenance = provenance_filter)
    order by ts_rank(be.content_search, plainto_tsquery('english', query_text)) desc
    limit (select fetch_n from params)
  ),
  fused as (
    select coalesce(v.id, f.id) as id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as rrf,
           v.sim
    from vec v
    full outer join fts f on f.id = v.id
  )
  select be.id, be.content, be.source, be.source_ref, be.metadata, be.people,
         be.topics, be.entry_type, be.captured_at,
         coalesce(fused.sim, 1 - (be.embedding <=> query_embedding)) as similarity,
         round(fused.rrf::numeric, 4)::float as rrf_score,
         be.status, be.superseded_by
  from fused
  join public.brain_entries be on be.id = fused.id
  order by fused.rrf desc
  limit (select k from params);
$fn$;

DROP FUNCTION public.match_brain_entries(vector, integer, text);

CREATE FUNCTION public.match_brain_entries(
  query_embedding vector,
  match_count integer DEFAULT 8,
  source_filter text DEFAULT NULL::text,
  include_history boolean DEFAULT false)
RETURNS TABLE(id uuid, content text, source text, source_ref text, metadata jsonb,
              people text[], topics text[], entry_type text,
              captured_at timestamp with time zone, similarity double precision,
              status text, superseded_by uuid)
LANGUAGE sql
STABLE
AS $fn$
  select
    brain_entries.id,
    brain_entries.content,
    brain_entries.source,
    brain_entries.source_ref,
    brain_entries.metadata,
    brain_entries.people,
    brain_entries.topics,
    brain_entries.entry_type,
    brain_entries.captured_at,
    1 - (brain_entries.embedding <=> query_embedding) as similarity,
    brain_entries.status,
    brain_entries.superseded_by
  from public.brain_entries
  where (source_filter is null or brain_entries.source = source_filter)
    and (include_history or brain_entries.status <> 'superseded')
  order by brain_entries.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$fn$;

-- 5) Self-aware stats -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.brain_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  select jsonb_build_object(
    'entry_count', count(*),
    'live_count', count(*) filter (where status <> 'superseded'),
    'superseded_count', count(*) filter (where status = 'superseded'),
    'status_counts', coalesce((
      select jsonb_object_agg(sc.status, sc.n)
      from (select status, count(*)::int as n from public.brain_entries group by status) sc
    ), '{}'::jsonb),
    'provenance_counts', coalesce((
      select jsonb_object_agg(coalesce(pc.provenance, 'unclassified'), pc.n)
      from (select provenance, count(*)::int as n from public.brain_entries group by provenance) pc
    ), '{}'::jsonb),
    'first_capture', min(captured_at),
    'last_capture', max(captured_at),
    'top_sources', coalesce((
      select jsonb_agg(jsonb_build_object('source', source, 'count', count))
      from (
        select source, count(*)::int
        from public.brain_entries
        group by source
        order by count(*) desc
        limit 10
      ) s
    ), '[]'::jsonb),
    'top_topics', coalesce((
      select jsonb_agg(jsonb_build_object('topic', topic, 'count', count))
      from (
        select topic, count(*)::int
        from public.brain_entries, unnest(topics) as topic
        group by topic
        order by count(*) desc
        limit 20
      ) t
    ), '[]'::jsonb)
  )
  from public.brain_entries;
$function$;

COMMIT;
