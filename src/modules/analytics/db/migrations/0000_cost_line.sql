CREATE TABLE "analytics"."cost_line" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"occurred_on" date NOT NULL,
	"category" text NOT NULL,
	"provider" text,
	"amount_cents" bigint NOT NULL,
	"origin" text NOT NULL,
	"origin_event_id" text,
	"account_id" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" text,
	"replaces_id" text,
	CONSTRAINT "cost_line_origin_valid" CHECK ("analytics"."cost_line"."origin" in ('usage', 'manual')),
	CONSTRAINT "cost_line_category_valid" CHECK ("analytics"."cost_line"."category" in ('partner_fees', 'data_vendors', 'agents_hosting', 'lists_events', 'ai_usage')),
	CONSTRAINT "cost_line_amount_valid" CHECK ("analytics"."cost_line"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cost_line_origin_event_unique" ON "analytics"."cost_line" USING btree ("origin_event_id");--> statement-breakpoint
CREATE INDEX "cost_line_tenant_occurred_idx" ON "analytics"."cost_line" USING btree ("tenant_id","occurred_on","created_at");--> statement-breakpoint
ALTER TABLE "analytics"."cost_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."cost_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."cost_line" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
