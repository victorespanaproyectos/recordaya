-- RecordaYa · base de conocimiento (RAG con pgvector)
-- Chatbot, Fase 3 (T-03.1). Depende de 0005. Reversión: supabase/migrations/down/0007.sql

create extension if not exists vector with schema extensions;

create type knowledge_source_type as enum ('faq', 'text', 'file', 'url');
create type knowledge_category as enum ('products_services', 'policies', 'hours', 'contact', 'faq', 'other');
create type knowledge_status as enum ('pending', 'processing', 'ready', 'failed', 'disabled');

create table knowledge_sources (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  type                knowledge_source_type not null,
  category            knowledge_category not null default 'other',
  title               text not null check (char_length(title) between 1 and 200),
  faq_question        text check (char_length(faq_question) <= 500),
  faq_answer          text check (char_length(faq_answer) <= 4000),
  body                text check (char_length(body) <= 50000),
  url                 text check (url ~ '^https://'),
  storage_path        text,
  status              knowledge_status not null default 'pending',
  active_document_id  uuid,                       -- FK agregada abajo (referencia circular)
  last_error          jsonb,
  chunk_count         int not null default 0,
  last_processed_at   timestamptz,
  created_by          uuid references business_members(id) on delete set null,
  updated_by          uuid references business_members(id) on delete set null,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (type <> 'faq'  or (faq_question is not null and faq_answer is not null)),
  check (type <> 'text' or body is not null),
  check (type <> 'url'  or url is not null)
);
create index knowledge_sources_business_idx on knowledge_sources (business_id, status) where deleted_at is null;
create index knowledge_sources_updated_idx on knowledge_sources (business_id, updated_at desc);
create trigger knowledge_sources_updated_at before update on knowledge_sources
  for each row execute function set_updated_at();

create table knowledge_documents (
  id                     uuid primary key default gen_random_uuid(),
  source_id              uuid not null references knowledge_sources(id) on delete cascade,
  business_id            uuid not null references businesses(id) on delete cascade,
  version                int not null,
  status                 knowledge_status not null default 'pending',
  mime_type              text,
  size_bytes             int check (size_bytes <= 10485760),
  checksum_sha256        text,
  extracted_text         text check (char_length(extracted_text) <= 500000),
  extracted_chars        int,
  embedding_model        text,
  embedding_dimensions   smallint,
  error                  jsonb,
  processing_started_at  timestamptz,
  processed_at           timestamptz,
  created_by             uuid references business_members(id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (source_id, version)
);
create index knowledge_documents_business_idx on knowledge_documents (business_id);

alter table knowledge_sources
  add constraint knowledge_sources_active_document_fk
  foreign key (active_document_id) references knowledge_documents(id) on delete set null;

create table knowledge_chunks (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  source_id       uuid not null references knowledge_sources(id) on delete cascade,
  document_id     uuid not null references knowledge_documents(id) on delete cascade,
  chunk_index     int not null,
  content         text not null,
  token_estimate  int not null,
  metadata        jsonb not null default '{}'::jsonb,
  embedding       extensions.vector(1024) not null,
  fts             tsvector generated always as (to_tsvector('spanish', content)) stored,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index knowledge_chunks_business_idx on knowledge_chunks (business_id, source_id);
create index knowledge_chunks_fts_idx on knowledge_chunks using gin (fts);
create index knowledge_chunks_embedding_idx on knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

alter table knowledge_sources   enable row level security;
alter table knowledge_documents enable row level security;
alter table knowledge_chunks    enable row level security;

-- Búsqueda híbrida (semántica + léxica) con Reciprocal Rank Fusion, siempre acotada a un negocio.
create or replace function match_knowledge_chunks(
  p_business_id      uuid,
  p_query_embedding  extensions.vector(1024),
  p_query_text       text,
  p_match_count      int   default 8,
  p_min_similarity   float default 0.30
) returns table (
  chunk_id uuid, source_id uuid, title text, category knowledge_category,
  content text, metadata jsonb, similarity float, rank_score float
)
language sql stable security invoker set search_path = public, extensions as $$
  with active as materialized (
    select c.id, c.source_id, c.content, c.metadata, c.fts,
           1 - (c.embedding <=> p_query_embedding) as similarity
    from knowledge_chunks c
    join knowledge_sources s
      on s.id = c.source_id and s.active_document_id = c.document_id
    where c.business_id = p_business_id
      and s.business_id = p_business_id
      and s.status = 'ready' and s.deleted_at is null
  ),
  semantic as (
    select id, row_number() over (order by similarity desc) as rnk
    from active order by similarity desc limit 30
  ),
  lexical as (
    select a.id, row_number() over (order by ts_rank_cd(a.fts, q) desc) as rnk
    from active a, websearch_to_tsquery('spanish', p_query_text) q
    where a.fts @@ q
    order by ts_rank_cd(a.fts, q) desc limit 30
  ),
  fused as (
    select coalesce(s.id, l.id) as id,
           coalesce(1.0 / (60 + s.rnk), 0) + coalesce(1.0 / (60 + l.rnk), 0) as rank_score,
           (l.id is not null) as lexical_hit
    from semantic s full outer join lexical l on l.id = s.id
  )
  select a.id, a.source_id, ks.title, ks.category, a.content, a.metadata, a.similarity, f.rank_score
  from fused f
  join active a on a.id = f.id
  join knowledge_sources ks on ks.id = a.source_id
  -- Exige similitud semántica mínima o coincidencia léxica real. (La versión original comparaba
  -- rank_score >= 1/61, que el fragmento nº 1 de la búsqueda semántica cumple siempre, aun con similitud ~0.)
  where a.similarity >= p_min_similarity or f.lexical_hit
  order by f.rank_score desc
  limit p_match_count;
$$;

-- Activa una versión procesada de forma atómica y purga los fragmentos de versiones anteriores.
create or replace function activate_knowledge_document(p_document_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare v_source uuid; v_chunks int;
begin
  select source_id into v_source from knowledge_documents where id = p_document_id for update;
  if v_source is null then raise exception 'documento inexistente'; end if;
  select count(*) into v_chunks from knowledge_chunks where document_id = p_document_id;

  update knowledge_documents set status = 'ready', processed_at = now() where id = p_document_id;
  update knowledge_sources
     set active_document_id = p_document_id, status = 'ready', chunk_count = v_chunks,
         last_processed_at = now(), last_error = null
   where id = v_source and status <> 'disabled' and deleted_at is null;
  delete from knowledge_chunks where source_id = v_source and document_id <> p_document_id;
end;
$$;
