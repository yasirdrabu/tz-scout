CREATE TABLE "analytics"."cost_setting" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"target_cost_per_won_cents" bigint,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics"."cost_line" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "analytics"."cost_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."cost_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."cost_setting" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
