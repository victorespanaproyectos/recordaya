-- Reversión de 0010
do $$
declare t text;
begin
  foreach t in array array['chatbot_settings','knowledge_sources','knowledge_documents',
    'chat_contacts','conversations','conversation_messages','conversation_assignments',
    'conversation_events','unanswered_questions','business_members']
  loop
    execute format('drop policy if exists %I on %I', t || '_member_read', t);
  end loop;
end $$;
drop policy if exists chatbot_settings_admin_write on chatbot_settings;
drop policy if exists knowledge_sources_admin_write on knowledge_sources;
drop policy if exists chatbot_usage_admin_read on chatbot_usage;
drop policy if exists audit_log_owner_read on audit_log;
