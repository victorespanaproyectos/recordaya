-- RecordaYa · usuarios del panel por negocio (operadores)
-- Chatbot, Fase 3 (T-03.1). Aditiva: no modifica datos existentes.
-- Reversión: supabase/migrations/down/0005.sql

create type member_role as enum ('owner', 'admin', 'operator');
create type member_status as enum ('invited', 'active', 'disabled');

alter table businesses add column if not exists wa_phone_number_id text unique;

create table business_members (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null,
  email           text not null check (email = lower(email)),
  display_name    text not null check (char_length(display_name) between 1 and 80),
  role            member_role not null,
  status          member_status not null default 'invited',
  is_available    boolean not null default false,
  max_concurrent  smallint not null default 5 check (max_concurrent between 1 and 50),
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (business_id, email)
);
create unique index business_members_user_idx on business_members (business_id, user_id) where user_id is not null;
create index business_members_user_lookup_idx on business_members (user_id);
create trigger business_members_updated_at before update on business_members
  for each row execute function set_updated_at();
alter table business_members enable row level security;

-- Helpers para RLS (security definer: leen business_members sin recursión de políticas)
create or replace function is_business_member(p_business_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from business_members
    where business_id = p_business_id and user_id = auth.uid() and status = 'active');
$$;

create or replace function has_business_role(p_business_id uuid, p_roles member_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from business_members
    where business_id = p_business_id and user_id = auth.uid() and status = 'active' and role = any(p_roles));
$$;
revoke all on function is_business_member(uuid), has_business_role(uuid, member_role[]) from public;

-- RecordaYa · configuración del chatbot y auditoría administrativa
-- Chatbot, Fase 3 (T-03.1). Depende de 0005. Reversión: supabase/migrations/down/0006.sql

create type chatbot_tone as enum ('formal', 'friendly', 'neutral');

create table chatbot_settings (
  business_id                     uuid primary key references businesses(id) on delete cascade,
  enabled                         boolean not null default false,
  assistant_name                  text not null default 'Asistente' check (char_length(assistant_name) <= 40),
  business_description            text check (char_length(business_description) <= 1000),
  tone                            chatbot_tone not null default 'friendly',
  personality                     text check (char_length(personality) <= 500),
  instructions                    text check (char_length(instructions) <= 4000),
  language                        text not null default 'es',
  auto_language                   boolean not null default true,
  welcome_message                 text not null default '¡Hola! Soy el asistente virtual de {negocio}. ¿En qué te ayudo?',
  handoff_offer_message           text not null default '¿Quieres que te atienda una persona del equipo?',
  handoff_confirmed_message       text not null default 'Listo, te paso con una persona del equipo. Te responderán por aquí.',
  out_of_hours_message            text not null default 'Ahora no hay nadie del equipo disponible. Te responderemos {proximo_horario}.',
  no_info_message                 text not null default 'No tengo esa información. Si quieres, te comunico con una persona del equipo.',
  closing_message                 text,
  unsupported_content_message     text not null default 'Por ahora solo puedo leer mensajes de texto.',
  human_hours                     jsonb not null default '{}'::jsonb,
  max_answer_chars                smallint not null default 700 check (max_answer_chars between 200 and 1500),
  offer_human_after_failures      smallint not null default 2 check (offer_human_after_failures between 1 and 5),
  inactivity_close_hours          smallint not null default 24 check (inactivity_close_hours between 1 and 168),
  answer_questions_on_reminder_replies boolean not null default true,
  confidence_threshold            numeric(3,2) not null default 0.60 check (confidence_threshold between 0 and 1),
  -- D-03 revisada (demo gratuita): 'default' = el modelo definido por el servidor (LLM_DEFAULT_MODEL en config.ts).
  -- La lista blanca de modelos vive en el código, no en la base.
  llm_model                       text not null default 'default',
  llm_effort                      text not null default 'low' check (llm_effort in ('low','medium','high')),
  monthly_budget_usd              numeric(10,2) not null default 20 check (monthly_budget_usd >= 0),
  widget_public_key               text unique,
  widget_allowed_origins          text[] not null default '{}',
  updated_by                      uuid references business_members(id) on delete set null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);
create trigger chatbot_settings_updated_at before update on chatbot_settings
  for each row execute function set_updated_at();
alter table chatbot_settings enable row level security;

create table audit_log (
  id               bigint generated always as identity primary key,
  business_id      uuid not null references businesses(id) on delete cascade,
  actor_member_id  uuid references business_members(id) on delete set null,
  action           text not null,
  target_type      text,
  target_id        text,
  diff             jsonb,
  ip_hash          text,
  created_at       timestamptz not null default now()
);
create index audit_log_business_idx on audit_log (business_id, created_at desc);
alter table audit_log enable row level security;

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

-- RecordaYa · conversaciones, mensajes y atención humana
-- Chatbot, Fase 3 (T-03.1). Depende de 0001 y 0005. Reversión: supabase/migrations/down/0008.sql

create type chat_channel as enum ('whatsapp', 'web');
create type conversation_status as enum ('bot', 'pending_human', 'human', 'resolved', 'closed');
create type handoff_reason as enum ('customer_request', 'no_information', 'low_confidence',
  'unsupported_content', 'sensitive_topic', 'operator_initiated', 'budget_exhausted');
create type conversation_resolver as enum ('bot', 'human', 'system');
create type message_sender as enum ('customer', 'bot', 'agent', 'system');

create table chat_contacts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  channel       chat_channel not null,
  external_id   text not null,
  display_name  text,
  customer_id   uuid references customers(id) on delete set null,
  blocked       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, channel, external_id)
);
create trigger chat_contacts_updated_at before update on chat_contacts
  for each row execute function set_updated_at();

create table conversations (
  id                           uuid primary key default gen_random_uuid(),
  business_id                  uuid not null references businesses(id) on delete cascade,
  contact_id                   uuid not null references chat_contacts(id) on delete cascade,
  channel                      chat_channel not null,
  status                       conversation_status not null default 'bot',
  assigned_member_id           uuid references business_members(id) on delete set null,
  assigned_at                  timestamptz,
  handoff_reason               handoff_reason,
  handoff_offered_at           timestamptz,
  handoff_requested_at         timestamptz,
  consecutive_failures         smallint not null default 0,
  summary                      text,
  appointment_id               uuid references appointments(id) on delete set null,
  last_inbound_at              timestamptz,
  last_message_at              timestamptz not null default now(),
  last_out_of_hours_notice_at  timestamptz,
  unread_count                 int not null default 0,
  bot_lock_until               timestamptz,
  first_response_at            timestamptz,
  resolved_at                  timestamptz,
  closed_at                    timestamptz,
  resolved_by                  conversation_resolver,
  version                      int not null default 0,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  check ((status = 'human') = (assigned_member_id is not null))
);
create unique index conversations_one_open_idx on conversations (business_id, contact_id, channel)
  where status <> 'closed';
create index conversations_inbox_idx on conversations (business_id, status, last_message_at desc);
create index conversations_assigned_idx on conversations (assigned_member_id) where status = 'human';
create trigger conversations_updated_at before update on conversations
  for each row execute function set_updated_at();

create table conversation_messages (
  id                   uuid primary key default gen_random_uuid(),
  conversation_id      uuid not null references conversations(id) on delete cascade,
  business_id          uuid not null references businesses(id) on delete cascade,
  direction            text not null check (direction in ('inbound', 'outbound')),
  sender_type          message_sender not null,
  sender_member_id     uuid references business_members(id) on delete set null,
  content_type         text not null default 'text',
  body                 text check (char_length(body) <= 4096),
  inbound_message_id   uuid unique references inbound_messages(id) on delete set null,
  reply_to_message_id  uuid references conversation_messages(id) on delete set null,
  wa_message_id        text unique,
  status               message_status not null,
  client_request_id    text unique,
  ai                   jsonb,
  error                jsonb,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  created_at           timestamptz not null default now()
);
create index conversation_messages_conv_idx on conversation_messages (conversation_id, created_at);
create unique index conversation_messages_one_bot_reply_idx on conversation_messages (reply_to_message_id)
  where sender_type = 'bot';
create index conversation_messages_search_idx on conversation_messages
  using gin (to_tsvector('spanish', coalesce(body, '')));

create table conversation_assignments (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  business_id      uuid not null references businesses(id) on delete cascade,
  member_id        uuid not null references business_members(id) on delete cascade,
  assigned_by      uuid references business_members(id) on delete set null,
  assigned_at      timestamptz not null default now(),
  released_at      timestamptz,
  release_reason   text check (release_reason in ('released','returned_to_bot','resolved','reassigned','member_disabled','closed'))
);
create index conversation_assignments_conv_idx on conversation_assignments (conversation_id, assigned_at desc);
create unique index conversation_assignments_open_idx on conversation_assignments (conversation_id)
  where released_at is null;

create table conversation_events (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  business_id      uuid not null references businesses(id) on delete cascade,
  type             text not null,
  actor_type       text not null check (actor_type in ('customer','bot','member','system')),
  actor_member_id  uuid references business_members(id) on delete set null,
  from_status      conversation_status,
  to_status        conversation_status,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index conversation_events_conv_idx on conversation_events (conversation_id, created_at);

alter table chat_contacts            enable row level security;
alter table conversations            enable row level security;
alter table conversation_messages    enable row level security;
alter table conversation_assignments enable row level security;
alter table conversation_events      enable row level security;

-- Toma atómica: solo una llamada concurrente puede ganar.
create or replace function claim_conversation(
  p_conversation_id uuid, p_business_id uuid, p_member_id uuid, p_assigned_by uuid default null
) returns boolean
language plpgsql security invoker set search_path = public as $$
declare
  v_from conversation_status;
begin
  -- Bloquea la fila: la segunda llamada concurrente espera y luego ve assigned_member_id ya ocupado.
  select status into v_from from conversations
   where id = p_conversation_id and business_id = p_business_id
     and assigned_member_id is null and status in ('pending_human', 'bot', 'resolved')
   for update;
  if not found then return false; end if;

  update conversations
     set status = 'human', assigned_member_id = p_member_id, assigned_at = now(),
         handoff_reason = coalesce(handoff_reason, 'operator_initiated'),
         unread_count = 0, version = version + 1
   where id = p_conversation_id;

  insert into conversation_assignments (conversation_id, business_id, member_id, assigned_by)
  values (p_conversation_id, p_business_id, p_member_id, coalesce(p_assigned_by, p_member_id));
  insert into conversation_events (conversation_id, business_id, type, actor_type, actor_member_id, from_status, to_status)
  values (p_conversation_id, p_business_id, 'claimed', 'member', coalesce(p_assigned_by, p_member_id), v_from, 'human');
  return true;
end;
$$;

-- Lease del job de IA (cada llamada RPC es su propia transacción, por eso no se usan advisory locks).
create or replace function try_lock_conversation(p_conversation_id uuid, p_seconds int default 90)
returns boolean language sql security invoker set search_path = public as $$
  with locked as (
    update conversations set bot_lock_until = now() + make_interval(secs => p_seconds)
     where id = p_conversation_id and (bot_lock_until is null or bot_lock_until < now())
    returning id)
  select exists (select 1 from locked);
$$;

create or replace function unlock_conversation(p_conversation_id uuid)
returns void language sql security invoker set search_path = public as $$
  update conversations set bot_lock_until = null where id = p_conversation_id;
$$;

-- RecordaYa · consumo de IA y preguntas sin respuesta
-- Chatbot, Fase 3 (T-03.1). Depende de 0007 y 0008. Reversión: supabase/migrations/down/0009.sql

create table chatbot_usage (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  conversation_id     uuid references conversations(id) on delete set null,
  message_id          uuid references conversation_messages(id) on delete set null,
  operation           text not null check (operation in ('chat','summary','embedding_query','embedding_ingest','playground')),
  provider            text not null,
  model               text not null,
  input_tokens        int not null default 0,
  cache_read_tokens   int not null default 0,
  cache_write_tokens  int not null default 0,
  output_tokens       int not null default 0,
  cost_usd            numeric(12,6) not null default 0,
  latency_ms          int,
  status              text not null default 'ok' check (status in ('ok','error','refusal')),
  created_at          timestamptz not null default now()
);
create index chatbot_usage_business_idx on chatbot_usage (business_id, created_at);
alter table chatbot_usage enable row level security;

create view chatbot_usage_monthly with (security_invoker = true) as
  select business_id, date_trunc('month', created_at) as month, operation,
         sum(input_tokens) as input_tokens, sum(cache_read_tokens) as cache_read_tokens,
         sum(output_tokens) as output_tokens, sum(cost_usd) as cost_usd, count(*) as calls
  from chatbot_usage group by 1, 2, 3;

create table unanswered_questions (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  conversation_id     uuid references conversations(id) on delete set null,
  message_id          uuid references conversation_messages(id) on delete set null,
  question            text not null check (char_length(question) <= 1000),
  reason              text not null check (reason in ('no_context','low_confidence','out_of_scope','unsupported_content','handoff')),
  status              text not null default 'open' check (status in ('open','resolved','ignored')),
  resolved_source_id  uuid references knowledge_sources(id) on delete set null,
  resolved_by         uuid references business_members(id) on delete set null,
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz
);
create index unanswered_questions_business_idx on unanswered_questions (business_id, status, created_at desc);
alter table unanswered_questions enable row level security;

-- RecordaYa · políticas RLS para el rol `authenticated` (defensa en profundidad)
-- Chatbot, Fase 3 (T-03.1). Depende de 0005–0009. Reversión: supabase/migrations/down/0010.sql
--
-- El backend usa la clave secreta (service_role, salta RLS). Mientras no se otorguen grants al rol
-- `authenticated`, ningún cliente con JWT de usuario puede leer estas tablas aunque existan políticas.

-- Lectura para miembros del negocio
do $$
declare t text;
begin
  foreach t in array array['chatbot_settings','knowledge_sources','knowledge_documents',
    'chat_contacts','conversations','conversation_messages','conversation_assignments',
    'conversation_events','unanswered_questions','business_members']
  loop
    execute format(
      'create policy %I on %I for select to authenticated using (is_business_member(business_id))',
      t || '_member_read', t);
  end loop;
end $$;

-- Configuración, conocimiento, equipo y consumo: solo owner/admin
create policy chatbot_settings_admin_write on chatbot_settings for update to authenticated
  using (has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (has_business_role(business_id, array['owner','admin']::member_role[]));
create policy knowledge_sources_admin_write on knowledge_sources for all to authenticated
  using (has_business_role(business_id, array['owner','admin']::member_role[]))
  with check (has_business_role(business_id, array['owner','admin']::member_role[]));
create policy chatbot_usage_admin_read on chatbot_usage for select to authenticated
  using (has_business_role(business_id, array['owner','admin']::member_role[]));
create policy audit_log_owner_read on audit_log for select to authenticated
  using (has_business_role(business_id, array['owner']::member_role[]));
-- knowledge_chunks: sin políticas para authenticated (solo servidor).

-- RecordaYa · bucket privado para los archivos de la base de conocimiento
-- Chatbot, Fase 3 (T-03.1). Reversión: supabase/migrations/down/0011.sql

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('knowledge', 'knowledge', false, 10485760,
  array['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;
-- Sin políticas para anon/authenticated: subida con signed upload URL generada en el servidor
-- y lectura solo con la clave secreta.

