CREATE TABLE "accounts"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"match_name" text NOT NULL,
	"domain" text,
	"website_url" text,
	"linkedin_url" text,
	"industry" text,
	"industry_key" text,
	"employees" integer,
	"employees_min" integer,
	"employees_max" integer,
	"revenue_cents" bigint,
	"revenue_min_cents" bigint,
	"revenue_max_cents" bigint,
	"hq_city" text,
	"hq_state" text,
	"hq_state_key" text,
	"hq_country" text,
	"description" text,
	"technologies" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"parent_domain" text,
	"headcount_growth_6m" numeric(8, 4),
	"founded_year" integer,
	"is_shell" boolean DEFAULT false NOT NULL,
	"research_tier" text,
	"research_tier_signal_at" timestamp with time zone,
	"practice_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_reason_key" text,
	"excluded_override" boolean DEFAULT false NOT NULL,
	"crm_status" text DEFAULT 'none' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts"."account_alias" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"system" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_alias_account_id_kind_system_value_pk" PRIMARY KEY("account_id","kind","system","value")
);
--> statement-breakpoint
CREATE TABLE "accounts"."account_summary" (
	"tenant_id" text NOT NULL,
	"account_id" text PRIMARY KEY NOT NULL,
	"priority" integer,
	"fit" integer,
	"intent" integer,
	"tier" text,
	"best_offer_id" text,
	"practice_id" text,
	"practice_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_status_key" text,
	"owner_user_id" text,
	"stage" text,
	"source_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_signal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts"."buying_role" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "buying_role_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "accounts"."exclusion_list" (
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "exclusion_list_tenant_id_kind_value_pk" PRIMARY KEY("tenant_id","kind","value")
);
--> statement-breakpoint
CREATE TABLE "accounts"."exclusion_rule" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "exclusion_rule_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "accounts"."fact" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"person_id" text,
	"key" text NOT NULL,
	"value" jsonb,
	"value_type" text NOT NULL,
	"kind" text NOT NULL,
	"person_source_id" text,
	"agent_source_id" text,
	"vendor_source_id" text,
	"arrival_id" text,
	"url" text,
	"note" text,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"pinned_by" text,
	"pinned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts"."person" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"title" text,
	"seniority" text,
	"email" text,
	"email_status" text,
	"phone" text,
	"mobile_phone" text,
	"linkedin_url" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"decision_note" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts"."person_alias" (
	"tenant_id" text NOT NULL,
	"person_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"system" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_alias_person_id_kind_system_value_pk" PRIMARY KEY("person_id","kind","system","value")
);
--> statement-breakpoint
CREATE TABLE "accounts"."person_role" (
	"tenant_id" text NOT NULL,
	"person_id" text NOT NULL,
	"role_key" text NOT NULL,
	"origin" text NOT NULL,
	"set_by" text,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_role_person_id_role_key_pk" PRIMARY KEY("person_id","role_key")
);
--> statement-breakpoint
CREATE TABLE "accounts"."signal" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"type" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"url" text,
	"value" jsonb,
	"occurred_at" timestamp with time zone,
	"person_source_id" text,
	"agent_source_id" text,
	"vendor_source_id" text,
	"arrival_id" text,
	"external_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts"."account_alias" ADD CONSTRAINT "account_alias_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD CONSTRAINT "account_summary_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."fact" ADD CONSTRAINT "fact_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."fact" ADD CONSTRAINT "fact_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "accounts"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."person" ADD CONSTRAINT "person_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."person_alias" ADD CONSTRAINT "person_alias_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "accounts"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."person_role" ADD CONSTRAINT "person_role_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "accounts"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."signal" ADD CONSTRAINT "signal_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tenant_domain_uq" ON "accounts"."account" USING btree ("tenant_id","domain") WHERE archived_at is null and domain is not null;--> statement-breakpoint
CREATE INDEX "account_tenant_match_name_idx" ON "accounts"."account" USING btree ("tenant_id","match_name","hq_country");--> statement-breakpoint
CREATE INDEX "account_alias_lookup_idx" ON "accounts"."account_alias" USING btree ("tenant_id","kind",lower("value"));--> statement-breakpoint
CREATE INDEX "account_summary_source_ids_idx" ON "accounts"."account_summary" USING gin ("source_ids");--> statement-breakpoint
CREATE INDEX "account_summary_practice_ids_idx" ON "accounts"."account_summary" USING gin ("practice_ids");--> statement-breakpoint
CREATE INDEX "account_summary_priority_idx" ON "accounts"."account_summary" USING btree ("tenant_id","priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "fact_tenant_account_key_idx" ON "accounts"."fact" USING btree ("tenant_id","account_id","key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "person_tenant_account_email_uq" ON "accounts"."person" USING btree ("tenant_id","account_id",lower("email")) WHERE archived_at is null and email is not null;--> statement-breakpoint
CREATE INDEX "person_tenant_account_idx" ON "accounts"."person" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "person_alias_lookup_idx" ON "accounts"."person_alias" USING btree ("tenant_id","kind",lower("value"));--> statement-breakpoint
CREATE INDEX "signal_tenant_account_idx" ON "accounts"."signal" USING btree ("tenant_id","account_id","occurred_at");--> statement-breakpoint
ALTER TABLE "accounts"."account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."account" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."account_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account_alias" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."account_alias" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."person" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."person" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."person_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."person_role" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."person_role" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."person_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."person_alias" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."person_alias" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."fact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."fact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."fact" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."signal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."signal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."signal" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."buying_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."buying_role" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."buying_role" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."exclusion_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."exclusion_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."exclusion_rule" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."exclusion_list" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."exclusion_list" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."exclusion_list" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."account_summary" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
