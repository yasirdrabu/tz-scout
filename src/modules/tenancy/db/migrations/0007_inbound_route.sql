CREATE TABLE "tenancy"."inbound_route" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenancy"."inbound_route" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenancy"."inbound_route" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenancy"."inbound_route" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
-- One-time backfill of connections made before the index, while every workspace is in this database.
-- From here on integrations registers each new connection through tenancy.
DO $$
BEGIN
  IF to_regclass('integrations.connection') IS NOT NULL THEN
    INSERT INTO "tenancy"."inbound_route" ("connection_id", "tenant_id")
    SELECT "id", "tenant_id" FROM "integrations"."connection"
    ON CONFLICT ("connection_id") DO NOTHING;
  END IF;
END $$;
