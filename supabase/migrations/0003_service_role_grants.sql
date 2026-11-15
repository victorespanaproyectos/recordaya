-- RecordaYa · permisos para el servidor
-- Los proyectos nuevos de Supabase no dan acceso automático a las tablas creadas por SQL.
-- El backend usa la secret key (rol service_role), que necesita estos permisos.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Tablas y secuencias que se creen en el futuro.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
