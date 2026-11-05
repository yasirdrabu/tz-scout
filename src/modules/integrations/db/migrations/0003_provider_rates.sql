CREATE TABLE "integrations"."paid_pause" (
	"tenant_id" text NOT NULL,
	"category" text NOT NULL,
	"month" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	CONSTRAINT "paid_pause_tenant_id_category_month_pk" PRIMARY KEY("tenant_id","category","month")
);
--> statement-breakpoint
CREATE TABLE "integrations"."provider_rate" (
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"item" text NOT NULL,
	"cents_per_unit" numeric(14, 6) NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_rate_tenant_id_provider_item_pk" PRIMARY KEY("tenant_id","provider","item")
);

--> statement-breakpoint
ALTER TABLE "integrations"."paid_pause" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."paid_pause" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."paid_pause" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "integrations"."provider_rate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."provider_rate" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."provider_rate" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));