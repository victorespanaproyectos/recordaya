-- RecordaYa · bucket privado para los archivos de la base de conocimiento
-- Chatbot, Fase 3 (T-03.1). Reversión: supabase/migrations/down/0011.sql

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('knowledge', 'knowledge', false, 10485760,
  array['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;
-- Sin políticas para anon/authenticated: subida con signed upload URL generada en el servidor
-- y lectura solo con la clave secreta.
