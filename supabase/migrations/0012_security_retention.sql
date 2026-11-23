-- RecordaYa · seguridad y retención (límite de intentos de login, borrado de datos de un contacto)
-- Chatbot, Fase 12 (T-12.6, 07 §19.2 y §19.12). Depende de 0001, 0008 y 0009. Reversión: supabase/migrations/down/0012.sql

-- Intentos fallidos del login legacy (contraseña compartida), por IP con hash. Se limpia en el mantenimiento.
create table if not exists login_attempts (
  id            bigint generated always as identity primary key,
  ip_hash       text not null,
  attempted_at  timestamptz not null default now()
);
create index if not exists login_attempts_ip_idx on login_attempts (ip_hash, attempted_at desc);
alter table login_attempts enable row level security;
grant select, insert, delete on login_attempts to service_role;
grant usage on sequence login_attempts_id_seq to service_role;

-- Borra todos los datos de un contacto (07 §19.12) en una sola transacción y devuelve los conteos.
-- Alcance (spec): chat_contacts y su cascada (conversaciones, mensajes, eventos, asignaciones),
-- preguntas sin respuesta de sus conversaciones, inbound_messages y webhook_events que contengan su teléfono.
create or replace function delete_contact_data(p_business_id uuid, p_contact_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_external text;
  v_channel chat_channel;
  v_unanswered int := 0;
  v_inbound int := 0;
  v_webhooks int := 0;
  v_conversations int := 0;
begin
  select external_id, channel into v_external, v_channel
    from chat_contacts where id = p_contact_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select count(*) into v_conversations from conversations where contact_id = p_contact_id;

  delete from unanswered_questions
   where business_id = p_business_id
     and conversation_id in (select id from conversations where contact_id = p_contact_id);
  get diagnostics v_unanswered = row_count;

  delete from chat_contacts where id = p_contact_id and business_id = p_business_id;

  if v_channel = 'whatsapp' then
    delete from inbound_messages where from_phone = v_external;
    get diagnostics v_inbound = row_count;
    delete from webhook_events where payload::text like '%"' || v_external || '"%';
    get diagnostics v_webhooks = row_count;
  end if;

  return jsonb_build_object(
    'conversations', v_conversations,
    'unanswered_questions', v_unanswered,
    'inbound_messages', v_inbound,
    'webhook_events', v_webhooks
  );
end;
$$;
revoke all on function delete_contact_data(uuid, uuid) from public, anon, authenticated;
grant execute on function delete_contact_data(uuid, uuid) to service_role;
