CREATE TABLE "routing"."account_review" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"status_key" text NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_by" text,
	"lead_offer_override_id" text,
	"insights" text,
	"insights_by" text,
	"insights_at" timestamp with time zone,
	"current_assignment_id" text,
	"stage" text DEFAULT 'arrived' NOT NULL,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_review_tenant_id_account_id_pk" PRIMARY KEY("tenant_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "routing"."assignment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seller_user_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"template_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"accepted_how" text,
	"decline_reason_key" text,
	"decline_note" text,
	"previous_assignment_id" text
);
--> statement-breakpoint
CREATE TABLE "routing"."decline_reason_def" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"applies_to" text NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "routing"."initial_status_rule" (
	"tenant_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text,
	"status_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing"."review_status_def" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"order" integer NOT NULL,
	"counts_as_reviewed" boolean DEFAULT false NOT NULL,
	"is_declined" boolean DEFAULT false NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"returns_to_source" boolean DEFAULT false NOT NULL,
	"tone" text DEFAULT 'neutral' NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "routing"."routing_setting" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"auto_accept_working_days" integer DEFAULT 2,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_setting_auto_accept_range" CHECK ("routing"."routing_setting"."auto_accept_working_days" is null or "routing"."routing_setting"."auto_accept_working_days" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "routing"."stage_change" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"from_stage" text NOT NULL,
	"to_stage" text NOT NULL,
	"cause_event_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing"."status_change" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"from_key" text,
	"to_key" text NOT NULL,
	"note" text,
	"reason_key" text,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_open_uq" ON "routing"."assignment" USING btree ("tenant_id","account_id") WHERE "routing"."assignment"."status" in ('pending', 'accepted');--> statement-breakpoint
CREATE INDEX "assignment_account_idx" ON "routing"."assignment" USING btree ("tenant_id","account_id","assigned_at");--> statement-breakpoint
CREATE INDEX "assignment_seller_idx" ON "routing"."assignment" USING btree ("tenant_id","seller_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "decline_reason_def_key_uq" ON "routing"."decline_reason_def" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "initial_status_rule_uq" ON "routing"."initial_status_rule" USING btree ("tenant_id","source_kind",coalesce("source_id", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "review_status_def_key_uq" ON "routing"."review_status_def" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_change_cause_uq" ON "routing"."stage_change" USING btree ("tenant_id","account_id","cause_event_id");--> statement-breakpoint
CREATE INDEX "stage_change_account_at_idx" ON "routing"."stage_change" USING btree ("tenant_id","account_id","at" desc);--> statement-breakpoint
CREATE INDEX "status_change_account_at_idx" ON "routing"."status_change" USING btree ("tenant_id","account_id","at" desc);
--> statement-breakpoint
ALTER TABLE "routing"."review_status_def" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."review_status_def" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."review_status_def" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."initial_status_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."initial_status_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."initial_status_rule" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."decline_reason_def" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."decline_reason_def" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."decline_reason_def" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."account_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."account_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."account_review" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."status_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."status_change" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."status_change" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."assignment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."assignment" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."stage_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."stage_change" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."stage_change" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "routing"."routing_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."routing_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."routing_setting" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
