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
