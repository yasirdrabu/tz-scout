CREATE TABLE "analytics"."budget_state" (
	"tenant_id" text NOT NULL,
	"category" text NOT NULL,
	"month" text NOT NULL,
	"level" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_state_tenant_id_category_month_pk" PRIMARY KEY("tenant_id","category","month"),
	CONSTRAINT "budget_state_level_valid" CHECK ("analytics"."budget_state"."level" in ('ok', 'alert', 'over', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "analytics"."cost_budget" (
	"tenant_id" text NOT NULL,
	"category" text NOT NULL,
	"month" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "cost_budget_tenant_id_category_month_pk" PRIMARY KEY("tenant_id","category","month"),
	CONSTRAINT "cost_budget_amount_valid" CHECK ("analytics"."cost_budget"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analytics"."budget_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."budget_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."budget_state" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
ALTER TABLE "analytics"."cost_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."cost_budget" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."cost_budget" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
