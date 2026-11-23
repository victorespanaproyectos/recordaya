-- Parche para recordaya-dev: corrige el filtro de match_knowledge_chunks (ya aplicado 0007 con la versión anterior).
-- Es idempotente (create or replace). En producción no hace falta: 0007 ya trae la versión corregida.

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
