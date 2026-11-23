-- Reversión de 0007 (destruye la base de conocimiento: exportar antes si hace falta)
drop function if exists match_knowledge_chunks(uuid, extensions.vector, text, int, float);
drop function if exists activate_knowledge_document(uuid);
alter table if exists knowledge_sources drop constraint if exists knowledge_sources_active_document_fk;
drop table if exists knowledge_chunks, knowledge_documents, knowledge_sources;
drop type if exists knowledge_status, knowledge_category, knowledge_source_type;
-- No se elimina la extensión vector: podría usarla otro objeto.
