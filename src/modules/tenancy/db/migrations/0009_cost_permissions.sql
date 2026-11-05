-- Custom SQL migration file, put your code below! --
-- R3a: saved role sets get the new cost permissions their role holds by default. They are new, so no
-- saved set can have unticked them. Only where missing, so running it again changes nothing.
UPDATE "tenancy"."role_permission" SET "permissions" = array_append("permissions", 'costs:read') WHERE "role" IN ('leader', 'operator') AND NOT ('costs:read' = ANY("permissions"));--> statement-breakpoint
UPDATE "tenancy"."role_permission" SET "permissions" = array_append("permissions", 'budgets:write') WHERE "role" = 'leader' AND NOT ('budgets:write' = ANY("permissions"));
