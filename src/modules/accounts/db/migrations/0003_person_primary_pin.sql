ALTER TABLE "accounts"."person" ADD COLUMN "primary_pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts"."person" ADD COLUMN "primary_pinned_by" text;