-- Idempotent bootstrap of one workspace database (D35). Run as scout_admin, which created the database
-- and owns it, so no superuser is needed: the roles already exist (bootstrap.sql, on the control plane).
-- Every module schema but tenancy (which lives on the control plane), and the same grants as there.

do $$
begin
  execute format('grant connect on database %I to scout_app', current_database());
end
$$;

create schema if not exists platform;
create schema if not exists integrations;
create schema if not exists ai;
create schema if not exists offers;
create schema if not exists accounts;
create schema if not exists intake;
create schema if not exists scoring;
create schema if not exists routing;
create schema if not exists crm;
create schema if not exists playbooks;

grant usage on schema platform, integrations, ai, offers, accounts, intake, scoring, routing, crm, playbooks to scout_app;
grant select, insert, update, delete on all tables in schema platform, integrations, ai, offers, accounts, intake, scoring, routing, crm, playbooks to scout_app;
grant usage, select on all sequences in schema platform, integrations, ai, offers, accounts, intake, scoring, routing, crm, playbooks to scout_app;

do $$ begin
  if to_regclass('platform.audit_log') is not null then
    revoke update, delete on platform.audit_log from scout_app;
  end if;
  if to_regclass('intake.arrival') is not null then
    revoke delete on intake.arrival from scout_app;
  end if;
end $$;

alter default privileges in schema platform, integrations, ai, offers, accounts, intake, scoring, routing, crm, playbooks
  grant select, insert, update, delete on tables to scout_app;
alter default privileges in schema platform, integrations, ai, offers, accounts, intake, scoring, routing, crm, playbooks
  grant usage, select on sequences to scout_app;
