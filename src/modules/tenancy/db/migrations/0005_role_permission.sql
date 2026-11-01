CREATE TABLE "tenancy"."role_permission" (
	"tenant_id" text NOT NULL,
	"role" text NOT NULL,
	"permissions" text[] NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_tenant_id_role_pk" PRIMARY KEY("tenant_id","role")
);
--> statement-breakpoint
ALTER TABLE "tenancy"."role_permission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenancy"."role_permission" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenancy"."role_permission" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
