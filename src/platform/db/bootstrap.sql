-- Idempotent bootstrap. Run by a superuser against the application database.
-- Creates the two runtime roles, the module schemas, and the grants between them.
-- Migrations (run as scout_admin) create tables; default privileges below give
-- scout_app data access to every table scout_admin creates later.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'scout_app') then
    create role scout_app login nobypassrls password 'scout_app';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'scout_admin') then
    create role scout_admin login bypassrls createdb password 'scout_admin';
  end if;
end
$$;

alter role scout_app login nobypassrls nosuperuser;
alter role scout_admin login bypassrls createdb nosuperuser;

do $$
begin
  execute format('alter database %I owner to scout_admin', current_database());
  execute format('grant connect on database %I to scout_app', current_database());
end
$$;

create schema if not exists platform authorization scout_admin;
create schema if not exists tenancy authorization scout_admin;
create schema if not exists integrations authorization scout_admin;
create schema if not exists ai authorization scout_admin;
create schema if not exists offers authorization scout_admin;

grant usage on schema platform, tenancy, integrations, ai, offers to scout_app;
grant select, insert, update, delete on all tables in schema platform, tenancy, integrations, ai, offers to scout_app;
grant usage, select on all sequences in schema platform, tenancy, integrations, ai, offers to scout_app;

-- The audit log is append only for the app role (table is created by migration 0005).
do $$ begin
  if to_regclass('platform.audit_log') is not null then
    revoke update, delete on platform.audit_log from scout_app;
  end if;
end $$;

alter default privileges for role scout_admin in schema platform, tenancy, integrations, ai, offers
  grant select, insert, update, delete on tables to scout_app;
alter default privileges for role scout_admin in schema platform, tenancy, integrations, ai, offers
  grant usage, select on sequences to scout_app;
