CREATE OR REPLACE FUNCTION public.hybrid_brain_entries(query_embedding vector, query_text text, match_count integer DEFAULT 8, source_filter text DEFAULT NULL::text, since timestamp with time zone DEFAULT NULL::timestamp with time zone, include_history boolean DEFAULT false, provenance_filter text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, content text, source text, source_ref text, metadata jsonb, people text[], topics text[], entry_type text, captured_at timestamp with time zone, similarity double precision, rrf_score double precision, status text, superseded_by uuid)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.match_brain_entries(query_embedding vector, match_count integer DEFAULT 8, source_filter text DEFAULT NULL::text, include_history boolean DEFAULT false)
 RETURNS TABLE(id uuid, content text, source text, source_ref text, metadata jsonb, people text[], topics text[], entry_type text, captured_at timestamp with time zone, similarity double precision, status text, superseded_by uuid)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

