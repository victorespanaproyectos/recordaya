-- Tras la reversión debe devolver: tablas_chatbot = 0, tipos_chatbot = 0, funciones_chatbot = 0,
-- columna_wa_phone_number_id = 0, bucket_knowledge = 0. (La extensión vector se conserva a propósito.)
select
  (select count(*) from information_schema.tables where table_schema = 'public' and table_name in (
    'business_members','chatbot_settings','audit_log','knowledge_sources','knowledge_documents','knowledge_chunks',
    'chat_contacts','conversations','conversation_messages','conversation_assignments','conversation_events',
    'chatbot_usage','chatbot_usage_monthly','unanswered_questions')) as tablas_chatbot,
  (select count(*) from pg_type where typname in ('member_role','member_status','chatbot_tone','knowledge_source_type',
    'knowledge_category','knowledge_status','chat_channel','conversation_status','handoff_reason',
    'conversation_resolver','message_sender')) as tipos_chatbot,
  (select count(*) from pg_proc where proname in ('is_business_member','has_business_role','match_knowledge_chunks',
    'activate_knowledge_document','claim_conversation','try_lock_conversation','unlock_conversation')) as funciones_chatbot,
  (select count(*) from information_schema.columns where table_name = 'businesses' and column_name = 'wa_phone_number_id') as columna_wa_phone_number_id,
  (select count(*) from storage.buckets where id = 'knowledge') as bucket_knowledge;
