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
