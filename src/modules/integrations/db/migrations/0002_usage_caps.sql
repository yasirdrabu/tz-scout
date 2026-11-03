CREATE TABLE "integrations"."usage_cap" (
	"tenant_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"unit" text NOT NULL,
	"period" text NOT NULL,
	"limit" bigint NOT NULL,
	"overage_period_start" date,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_cap_tenant_id_provider_key_pk" PRIMARY KEY("tenant_id","provider_key")
);
--> statement-breakpoint
CREATE TABLE "integrations"."usage_period" (
	"tenant_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"period_start" date NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"warned" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "usage_period_tenant_id_provider_key_period_start_pk" PRIMARY KEY("tenant_id","provider_key","period_start")
);

--> statement-breakpoint
ALTER TABLE "integrations"."usage_cap" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."usage_cap" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."usage_cap" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "integrations"."usage_period" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations"."usage_period" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "integrations"."usage_period" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
