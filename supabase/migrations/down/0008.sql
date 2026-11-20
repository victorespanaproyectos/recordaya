-- Reversión de 0008 (destruye conversaciones: exportar antes si hace falta)
drop function if exists claim_conversation(uuid, uuid, uuid, uuid);
drop function if exists try_lock_conversation(uuid, int);
drop function if exists unlock_conversation(uuid);
drop table if exists conversation_events, conversation_assignments, conversation_messages, conversations, chat_contacts;
drop type if exists message_sender, conversation_resolver, handoff_reason, conversation_status, chat_channel;
