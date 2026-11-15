-- RecordaYa · esquema inicial
-- Ejecutar en Supabase → SQL Editor (o con `supabase db push`).

-- ── Tipos ────────────────────────────────────────────────
create type appointment_status as enum (
  'scheduled', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show'
);

create type message_kind as enum (
  'reminder_24h', 'reminder_2h', 'confirmation', 'cancellation', 'reschedule', 'test'
);

create type message_status as enum (
  'queued', 'accepted', 'sent', 'delivered', 'read', 'failed', 'cancelled'
);

-- ── Utilidad: updated_at automático ─────────────────────
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Negocios ─────────────────────────────────────────────
create table businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'America/Montevideo',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Clientes del negocio ─────────────────────────────────
create table customers (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null,
  phone        text not null,               -- solo dígitos, formato internacional (59899123456)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (business_id, phone)
);

-- ── Turnos ───────────────────────────────────────────────
create table appointments (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  service      text,
  notes        text,
  status       appointment_status not null default 'scheduled',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index appointments_business_starts_idx on appointments (business_id, starts_at);

-- ── Mensajes salientes (historial + estado) ─────────────
create table messages (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  appointment_id  uuid references appointments(id) on delete set null,
  to_phone        text not null,
  kind            message_kind not null,
  template_name   text not null,
  variables       jsonb not null default '{}'::jsonb,
  wa_message_id   text unique,                -- wamid devuelto por la Cloud API
  status          message_status not null default 'queued',
  scheduled_for   timestamptz,                -- cuándo debe enviarse (recordatorios)
  schedule_id     text,                       -- id del envío programado (QStash), para cancelarlo
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  failed_at       timestamptz,
  error           jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index messages_appointment_idx on messages (appointment_id);
create index messages_status_idx on messages (status);

-- ── Mensajes entrantes (respuestas de clientes) ─────────
create table inbound_messages (
  id                      uuid primary key default gen_random_uuid(),
  wa_message_id           text not null unique,
  from_phone              text not null,
  type                    text not null,
  body                    text,
  reply_to_wa_message_id  text,                -- si responde a uno de nuestros mensajes
  payload                 jsonb not null,
  received_at             timestamptz not null,
  created_at              timestamptz not null default now()
);

create index inbound_messages_from_idx on inbound_messages (from_phone, received_at desc);

-- ── Log crudo de webhooks (útil para depurar) ───────────
create table webhook_events (
  id           bigint generated always as identity primary key,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

-- ── Triggers updated_at ─────────────────────────────────
create trigger businesses_updated_at   before update on businesses   for each row execute function set_updated_at();
create trigger customers_updated_at    before update on customers    for each row execute function set_updated_at();
create trigger appointments_updated_at before update on appointments for each row execute function set_updated_at();
create trigger messages_updated_at     before update on messages     for each row execute function set_updated_at();

-- ── Seguridad: RLS activado y sin políticas ─────────────
-- Solo el servidor (clave secreta) puede leer/escribir por ahora.
-- Cuando agreguemos login, se crean políticas por negocio.
alter table businesses       enable row level security;
alter table customers        enable row level security;
alter table appointments     enable row level security;
alter table messages         enable row level security;
alter table inbound_messages enable row level security;
alter table webhook_events   enable row level security;
