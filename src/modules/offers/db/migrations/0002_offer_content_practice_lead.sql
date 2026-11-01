ALTER TABLE "offers"."offer" ADD COLUMN "price_model" text;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD COLUMN "length_weeks" integer;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD COLUMN "key_offer" text;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD COLUMN "why_us" text;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD COLUMN "why_now" text;--> statement-breakpoint
ALTER TABLE "offers"."practice" ADD COLUMN "lead_user_id" text;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD CONSTRAINT "offer_price_model_valid" CHECK ("offers"."offer"."price_model" is null or "offers"."offer"."price_model" in ('fixed', 'starting_at', 'per_month', 'custom'));--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD CONSTRAINT "offer_length_weeks_range" CHECK ("offers"."offer"."length_weeks" is null or "offers"."offer"."length_weeks" between 1 and 260);