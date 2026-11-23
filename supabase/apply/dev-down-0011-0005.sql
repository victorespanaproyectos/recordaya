-- ===== down/0011 =====
-- Reversión de 0011. El trigger de protección de Storage exige este flag para borrar por SQL.
begin;
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'knowledge';
delete from storage.buckets where id = 'knowledge';
commit;

-- ===== down/0010 =====
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

-- ===== down/0009 =====
-- Reversión de 0009
drop table if exists unanswered_questions;
drop view if exists chatbot_usage_monthly;
drop table if exists chatbot_usage;

-- ===== down/0008 =====
-- Reversión de 0008 (destruye conversaciones: exportar antes si hace falta)
drop function if exists claim_conversation(uuid, uuid, uuid, uuid);
drop function if exists try_lock_conversation(uuid, int);
drop function if exists unlock_conversation(uuid);
drop table if exists conversation_events, conversation_assignments, conversation_messages, conversations, chat_contacts;
drop type if exists message_sender, conversation_resolver, handoff_reason, conversation_status, chat_channel;

-- ===== down/0007 =====
-- Reversión de 0007 (destruye la base de conocimiento: exportar antes si hace falta)
drop function if exists match_knowledge_chunks(uuid, extensions.vector, text, int, float);
drop function if exists activate_knowledge_document(uuid);
alter table if exists knowledge_sources drop constraint if exists knowledge_sources_active_document_fk;
drop table if exists knowledge_chunks, knowledge_documents, knowledge_sources;
drop type if exists knowledge_status, knowledge_category, knowledge_source_type;
-- No se elimina la extensión vector: podría usarla otro objeto.

-- ===== down/0006 =====
-- Reversión de 0006
drop table if exists audit_log, chatbot_settings;
drop type if exists chatbot_tone;

-- ===== down/0005 =====
-- Reversión de 0005
drop function if exists has_business_role(uuid, member_role[]);
drop function if exists is_business_member(uuid);
drop table if exists business_members;
drop type if exists member_status, member_role;
alter table businesses drop column if exists wa_phone_number_id;

