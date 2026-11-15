-- RecordaYa · recordatorios programados (QStash)
-- Ejecutar en Supabase → SQL Editor después de 0001_init.sql.

-- Dirección del negocio: la usa la plantilla de "turno confirmado".
alter table businesses add column if not exists address text;

-- Un solo recordatorio pendiente por tipo y turno (evita duplicados al reprogramar).
create unique index if not exists messages_one_queued_per_kind_idx
  on messages (appointment_id, kind)
  where status = 'queued';

-- Lo usa el job "dispatch" para encontrar recordatorios pendientes de programar.
create index if not exists messages_pending_dispatch_idx
  on messages (scheduled_for)
  where status = 'queued' and schedule_id is null;
