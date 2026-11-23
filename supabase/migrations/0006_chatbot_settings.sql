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
