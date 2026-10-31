CREATE TABLE "tenancy"."member_preference" (
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_preference_tenant_id_user_id_key_pk" PRIMARY KEY("tenant_id","user_id","key")
);
--> statement-breakpoint
ALTER TABLE "tenancy"."member_preference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenancy"."member_preference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenancy"."member_preference" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
