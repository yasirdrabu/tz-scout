-- Existing profiles take the four-weight defaults (no tenant has edited weights); the old fit/intent weights, trust modifier cap and tier thresholds go.
ALTER TABLE "scoring"."account_score" ADD COLUMN "revenue_score" integer;--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ADD COLUMN "trust_score" integer;--> statement-breakpoint
ALTER TABLE "scoring"."offer_match" ADD COLUMN "revenue_score" integer;--> statement-breakpoint
ALTER TABLE "scoring"."offer_match" ADD COLUMN "trust_score" integer;--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" ADD COLUMN "weights" jsonb DEFAULT '{"fit":40,"intent":25,"revenue":15,"trust":20}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" ADD COLUMN "tier_cutoffs" jsonb DEFAULT '{"actNow":75,"goodFit":55,"watch":35}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" DROP COLUMN "fit_weight";--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" DROP COLUMN "intent_weight";--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" DROP COLUMN "tier_thresholds";--> statement-breakpoint
ALTER TABLE "scoring"."scoring_profile" DROP COLUMN "trust_modifier_max";