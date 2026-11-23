-- Corrige los mensajes por defecto de chatbot_settings guardados con codificacion rota (Ã¡, Â¿...).
-- Solo ASCII: las tildes y signos van como escapes \uXXXX para que el portapapeles no los corrompa.
begin;

alter table chatbot_settings alter column welcome_message
  set default E'¡Hola! Soy el asistente virtual de {negocio}. ¿En qué te ayudo?';
alter table chatbot_settings alter column handoff_offer_message
  set default E'¿Quieres que te atienda una persona del equipo?';
alter table chatbot_settings alter column handoff_confirmed_message
  set default E'Listo, te paso con una persona del equipo. Te responderán por aquí.';
alter table chatbot_settings alter column no_info_message
  set default E'No tengo esa información. Si quieres, te comunico con una persona del equipo.';

-- Filas ya creadas con el texto roto (chr(195) = Ã, chr(194) = Â): se reemplazan por el valor correcto.
update chatbot_settings set welcome_message = E'¡Hola! Soy el asistente virtual de {negocio}. ¿En qué te ayudo?'
  where position(chr(195) in welcome_message) > 0 or position(chr(194) in welcome_message) > 0;
update chatbot_settings set handoff_offer_message = E'¿Quieres que te atienda una persona del equipo?'
  where position(chr(195) in handoff_offer_message) > 0 or position(chr(194) in handoff_offer_message) > 0;
update chatbot_settings set handoff_confirmed_message = E'Listo, te paso con una persona del equipo. Te responderán por aquí.'
  where position(chr(195) in handoff_confirmed_message) > 0 or position(chr(194) in handoff_confirmed_message) > 0;
update chatbot_settings set no_info_message = E'No tengo esa información. Si quieres, te comunico con una persona del equipo.'
  where position(chr(195) in no_info_message) > 0 or position(chr(194) in no_info_message) > 0;

commit;

-- Verificacion: debe leerse con tildes correctas.
select column_name, column_default from information_schema.columns
where table_name = 'chatbot_settings' and column_name like '%message';
