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
