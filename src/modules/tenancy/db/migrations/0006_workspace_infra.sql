CREATE TABLE "tenancy"."workspace_infra" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"database" text NOT NULL,
	"status" text NOT NULL,
	"schema_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seats" integer,
	"quotas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"last_backup_at" timestamp with time zone,
	"support_access_until" timestamp with time zone,
	"support_access_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenancy"."workspace_infra" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenancy"."workspace_infra" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenancy"."workspace_infra" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
-- Every existing workspace lives in this (the shared) database.
INSERT INTO "tenancy"."workspace_infra" ("tenant_id", "region", "database", "status")
SELECT "id", 'us-1', current_database(), 'active' FROM "tenancy"."tenant"
ON CONFLICT ("tenant_id") DO NOTHING;
