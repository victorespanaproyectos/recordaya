-- RecordaYa · respuestas de clientes (1 = confirmar, 2 = cancelar)

-- Mensajes de texto libre que la app contesta al cliente.
alter type message_kind add value if not exists 'reply';

-- A qué turno corresponde cada respuesta y qué intención se detectó.
alter table inbound_messages
  add column if not exists appointment_id uuid references appointments(id) on delete set null,
  add column if not exists intent text check (intent in ('confirm', 'cancel', 'unknown'));

create index if not exists inbound_messages_appointment_idx on inbound_messages (appointment_id);
