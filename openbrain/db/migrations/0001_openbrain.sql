create extension if not exists vector;

create table if not exists public.brain_entries (
  id uuid primary key default gen_random_uuid(),
  content text not null check (char_length(trim(content)) > 0),
  content_search tsvector generated always as (to_tsvector('english', content)) stored,
  embedding vector(1536) not null,
  source text not null default 'manual',
  source_ref text,
  metadata jsonb not null default '{}'::jsonb,
  people text[] not null default '{}',
  topics text[] not null default '{}',
  entry_type text not null default 'thought',
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- WhatsApp/Slack webhook retries: dedupe by (source, source_ref).
  -- NULL source_ref is allowed and not deduped (multiple NULLs coexist under Postgres UNIQUE).
  constraint brain_entries_source_unique unique (source, source_ref)
);

create index if not exists brain_entries_embedding_hnsw
  on public.brain_entries
  using hnsw (embedding vector_cosine_ops);

create index if not exists brain_entries_captured_at_idx
  on public.brain_entries (captured_at desc);

create index if not exists brain_entries_people_idx
  on public.brain_entries using gin (people);

create index if not exists brain_entries_topics_idx
  on public.brain_entries using gin (topics);

create index if not exists brain_entries_content_search_idx
  on public.brain_entries using gin (content_search);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists brain_entries_touch_updated_at on public.brain_entries;
create trigger brain_entries_touch_updated_at
before update on public.brain_entries
for each row
execute function public.touch_updated_at();

create or replace function public.match_brain_entries(
  query_embedding vector(1536),
  match_count int default 8,
  source_filter text default null
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
  similarity float
)
language sql
stable
as $$
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
    1 - (brain_entries.embedding <=> query_embedding) as similarity
  from public.brain_entries
  where source_filter is null or brain_entries.source = source_filter
  order by brain_entries.embedding <=> query_embedding
  limit greatest(1, least(match_count, 50));
$$;

create or replace function public.brain_stats()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'entry_count', count(*),
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
$$;

-- Application role for capture-server and mcp-server.
-- INSERT + SELECT only — no UPDATE/DELETE. Treats the brain as append-only.
-- After applying this migration, set the password:
--   ALTER ROLE openbrain_app WITH PASSWORD '...';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'openbrain_app') then
    create role openbrain_app login password 'CHANGE_ME_VIA_ALTER_ROLE';
  end if;
end$$;

grant connect on database openbrain to openbrain_app;
grant usage on schema public to openbrain_app;
grant select, insert on public.brain_entries to openbrain_app;
grant execute on function public.match_brain_entries(vector, int, text) to openbrain_app;
grant execute on function public.brain_stats() to openbrain_app;
