CREATE TABLE "integrations"."call_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"module" text,
	"principal_id" text,
	"api_key_id" text,
	"correlation_id" text,
	"request_summary" jsonb,
	"status_code" integer,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"units" integer,
	"unit" text,
	"cost_cents" integer,
	"error_message" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations"."connection" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"status" text DEFAULT 'not_set_up' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_id" text,
	"last_tested_at" timestamp with time zone,
	"last_test_result" jsonb,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations"."credential" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"key_version" integer NOT NULL,
	"hint" text NOT NULL,
	"expires_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "call_log_tenant_at_idx" ON "integrations"."call_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "call_log_tenant_provider_at_idx" ON "integrations"."call_log" USING btree ("tenant_id","provider","at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_tenant_provider_name_uq" ON "integrations"."connection" USING btree ("tenant_id","provider","name");--> statement-breakpoint
CREATE INDEX "credential_connection_idx" ON "integrations"."credential" USING btree ("tenant_id","connection_id");
--> statement-breakpoint
ALTER TABLE "integrations"."connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."connection" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "integrations"."credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."credential" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."credential" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "integrations"."call_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."call_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."call_log" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
