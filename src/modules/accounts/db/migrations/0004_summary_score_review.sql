ALTER TABLE "accounts"."account_summary" ADD COLUMN "score_version" integer;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "owner_history_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "review_version" integer;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "review_flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "has_open_assignment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "account_summary_owner_history_idx" ON "accounts"."account_summary" USING gin ("owner_history_user_ids");