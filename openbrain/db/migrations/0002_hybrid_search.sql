-- 0002: hybrid search — vector + full-text fused with reciprocal rank fusion.
--
-- The FTS infrastructure already exists (0001: content_search generated
-- tsvector + GIN index); this adds the fusion function. Vector finds semantic
-- matches; full-text catches exact terms (vendor names, invoice ids, property
-- names, IPs) that embeddings miss. RRF: score = sum over legs of 1/(c+rank),
-- c=60 (the standard constant); items ranked high in either leg surface,
-- items in both rank best.
--
-- Same signature family as match_brain_entries so the n8n search workflow
-- swaps with a one-line SQL change. Adds query_text (the raw query, for the
-- FTS leg) and an optional since filter.

create or replace function public.hybrid_brain_entries(
  query_embedding vector(1536),
  query_text text,
  match_count int default 8,
  source_filter text default null,
  since timestamptz default null
)
returns table (
  id uuid,
  content text,
  source text,
  source_ref text,
  metadata jsonb,
  people text[],
  topics text[],
  entry_type text,
  captured_at timestamptz,
  similarity float,
  rrf_score float
)
language sql
stable
as $$
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
         round(fused.rrf::numeric, 4)::float as rrf_score
  from fused
  join public.brain_entries be on be.id = fused.id
  order by fused.rrf desc
  limit (select k from params);
$$;

grant execute on function public.hybrid_brain_entries(vector, text, int, text, timestamptz) to public;
