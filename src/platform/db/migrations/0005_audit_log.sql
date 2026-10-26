CREATE TABLE "platform"."audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"source_id" text,
	"api_key_id" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"correlation_id" text,
	"ip" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at_idx" ON "platform"."audit_log" USING btree ("tenant_id","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "platform"."audit_log" USING btree ("tenant_id","actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "platform"."audit_log" USING btree ("tenant_id","subject_id");--> statement-breakpoint
ALTER TABLE "platform"."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform"."audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "platform"."audit_log" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
