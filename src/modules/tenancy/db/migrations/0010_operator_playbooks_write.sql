-- Custom SQL migration file, put your code below! --
-- R2c-2 gave operators playbooks:write by default; saved operator sets get it too (user 2026-11-05). Only where
-- missing, so running it again changes nothing.
UPDATE "tenancy"."role_permission" SET "permissions" = array_append("permissions", 'playbooks:write') WHERE "role" = 'operator' AND NOT ('playbooks:write' = ANY("permissions"));
