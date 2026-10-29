CREATE TABLE "scoring"."account_score" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"best_offer_id" text,
	"practice_id" text,
	"fit" integer NOT NULL,
	"intent" integer NOT NULL,
	"match_total" integer NOT NULL,
	"warm_points" integer DEFAULT 0 NOT NULL,
	"warm_introducer_id" text,
	"warm_introducer_name" text,
	"trust" numeric(5, 4),
	"trust_source_id" text,
	"trust_modifier" integer DEFAULT 0 NOT NULL,
	"priority" integer NOT NULL,
	"tier" text NOT NULL,
	"tier_reason" text NOT NULL,
	"revenue_potential_cents" bigint,
	"revenue_band" text,
	"explanation" jsonb NOT NULL,
	"inputs_hash" text NOT NULL,
	"profile_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_score_tenant_id_account_id_pk" PRIMARY KEY("tenant_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "scoring"."offer_match" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"fit" integer NOT NULL,
	"intent" integer NOT NULL,
	"match_total" integer NOT NULL,
	"tier" text NOT NULL,
	"fit_parts" jsonb NOT NULL,
	"rule_hits" jsonb NOT NULL,
	"disqualified_reason" text,
	"profile_version" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring"."score_change" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"from_priority" integer,
	"to_priority" integer NOT NULL,
	"from_tier" text,
	"to_tier" text NOT NULL,
	"from_offer_id" text,
	"to_offer_id" text,
	"cause" text NOT NULL,
	"cause_event_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring"."scoring_profile" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"fit_weight" numeric(5, 4) NOT NULL,
	"intent_weight" numeric(5, 4) NOT NULL,
	"fit_parts" jsonb NOT NULL,
	"half_life_days" integer NOT NULL,
	"max_signal_age_days" integer NOT NULL,
	"tier_thresholds" jsonb NOT NULL,
	"warm_intro_cap" integer NOT NULL,
	"trust_modifier_max" integer NOT NULL,
	"trust_neutral" numeric(5, 4) NOT NULL,
	"research_floor_days" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "offer_match_account_offer_uq" ON "scoring"."offer_match" USING btree ("tenant_id","account_id","offer_id");--> statement-breakpoint
CREATE INDEX "offer_match_offer_idx" ON "scoring"."offer_match" USING btree ("tenant_id","offer_id");--> statement-breakpoint
CREATE INDEX "score_change_account_at_idx" ON "scoring"."score_change" USING btree ("tenant_id","account_id","at" desc);
--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scoring"."scoring_profile" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "scoring"."offer_match" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scoring"."offer_match" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scoring"."offer_match" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scoring"."account_score" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scoring"."account_score" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

--> statement-breakpoint
ALTER TABLE "scoring"."score_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scoring"."score_change" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scoring"."score_change" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
