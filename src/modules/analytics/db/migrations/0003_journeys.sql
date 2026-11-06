CREATE TABLE "analytics"."journey" (
	"tenant_id" text NOT NULL,
	"account_id" text PRIMARY KEY NOT NULL,
	"first_source_id" text NOT NULL,
	"first_batch_id" text,
	"arrived_at" timestamp with time zone NOT NULL,
	"practice_id" text,
	"offer_id" text,
	"exit_stage" text,
	"exit_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics"."journey_deal" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"system" text NOT NULL,
	"deal_external_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" bigint,
	"closed_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "journey_deal_tenant_id_system_deal_external_id_pk" PRIMARY KEY("tenant_id","system","deal_external_id"),
	CONSTRAINT "journey_deal_status_valid" CHECK ("analytics"."journey_deal"."status" in ('open', 'won', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "analytics"."journey_stage" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"stage_key" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "journey_stage_tenant_id_account_id_stage_key_pk" PRIMARY KEY("tenant_id","account_id","stage_key")
);
--> statement-breakpoint
CREATE INDEX "journey_deal_account_idx" ON "analytics"."journey_deal" USING btree ("tenant_id","account_id");--> statement-breakpoint
ALTER TABLE "analytics"."journey" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."journey" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."journey" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
ALTER TABLE "analytics"."journey_deal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."journey_deal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."journey_deal" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
ALTER TABLE "analytics"."journey_stage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."journey_stage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."journey_stage" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
