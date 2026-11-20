-- Reversión de 0005
drop function if exists has_business_role(uuid, member_role[]);
drop function if exists is_business_member(uuid);
drop table if exists business_members;
drop type if exists member_status, member_role;
alter table businesses drop column if exists wa_phone_number_id;
