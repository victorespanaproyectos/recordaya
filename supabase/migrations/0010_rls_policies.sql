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
