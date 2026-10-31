-- Existing scores: the tier they hold is the one Scout scored (no override existed before).
ALTER TABLE "scoring"."account_score" ADD COLUMN "scored_tier" text;--> statement-breakpoint
UPDATE "scoring"."account_score" SET "scored_tier" = "tier";--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ALTER COLUMN "scored_tier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ADD COLUMN "tier_override" text;--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ADD COLUMN "tier_override_by" text;--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ADD COLUMN "tier_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scoring"."account_score" ADD COLUMN "tier_override_note" text;--> statement-breakpoint
ALTER TABLE "scoring"."score_change" ADD COLUMN "by" text;--> statement-breakpoint
ALTER TABLE "scoring"."score_change" ADD COLUMN "note" text;