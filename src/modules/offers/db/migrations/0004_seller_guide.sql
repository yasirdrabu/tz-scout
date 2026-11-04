ALTER TABLE "offers"."offer" ADD COLUMN "talking_points" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD COLUMN "objections" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD COLUMN "avoid" text[] DEFAULT '{}'::text[] NOT NULL;