-- Conteos de las tablas EXISTENTES. Ejecutar antes y después de aplicar las migraciones: deben ser idénticos.
select
  (select count(*) from businesses)       as businesses,
  (select count(*) from customers)        as customers,
  (select count(*) from appointments)     as appointments,
  (select count(*) from messages)         as messages,
  (select count(*) from inbound_messages) as inbound_messages,
  (select count(*) from webhook_events)   as webhook_events;
