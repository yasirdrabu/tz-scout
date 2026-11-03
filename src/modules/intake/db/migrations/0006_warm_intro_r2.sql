ALTER TABLE "intake"."warm_intro" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro" ADD COLUMN "repriced_change_id" text;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro_rule" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "intake"."warm_intro_rule" SET "id" = 'wir_' || upper(replace(gen_random_uuid()::text, '-', '')) WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro_rule" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro_rule" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "intake"."warm_intro_rule" ADD COLUMN "introducer_name" text;--> statement-breakpoint
CREATE INDEX "warm_intro_tenant_change_idx" ON "intake"."warm_intro" USING btree ("tenant_id","repriced_change_id");