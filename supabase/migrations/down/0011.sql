-- Reversión de 0011. El trigger de protección de Storage exige este flag para borrar por SQL.
begin;
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'knowledge';
delete from storage.buckets where id = 'knowledge';
commit;
