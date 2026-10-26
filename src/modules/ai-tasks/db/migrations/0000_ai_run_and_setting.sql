CREATE TABLE "ai"."ai_run" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"task" text NOT NULL,
	"prompt_version" text NOT NULL,
	"mode" text NOT NULL,
	"model" text,
	"input_hash" text NOT NULL,
	"input_ref" jsonb,
	"status" text NOT NULL,
	"output" jsonb,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"actor" text NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai"."ai_setting" (
	"tenant_id" text NOT NULL,
	"task" text NOT NULL,
	"model" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_cost_cents_per_run" integer,
	CONSTRAINT "ai_setting_tenant_id_task_pk" PRIMARY KEY("tenant_id","task")
);
--> statement-breakpoint
CREATE INDEX "ai_run_tenant_created_idx" ON "ai"."ai_run" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_run_reuse_idx" ON "ai"."ai_run" USING btree ("tenant_id","task","prompt_version","input_hash");
--> statement-breakpoint
ALTER TABLE "ai"."ai_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."ai_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai"."ai_run" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "ai"."ai_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai"."ai_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai"."ai_setting" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
