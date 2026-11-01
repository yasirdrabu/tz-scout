ALTER TABLE "intake"."crm_lead_poll" ADD COLUMN "polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake"."source" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "intake"."source_feedback" ADD COLUMN "by_user_id" text;--> statement-breakpoint
-- Data (Decision 11, Ruling 3): a person source is owned by its person, an agent by its parent's person.
UPDATE "intake"."source" SET "owner_user_id" = "user_id" WHERE "kind" = 'person' AND "user_id" IS NOT NULL AND "owner_user_id" IS NULL;--> statement-breakpoint
UPDATE "intake"."source" c SET "owner_user_id" = p."user_id"
FROM "intake"."source" p
WHERE c."parent_id" = p."id" AND c."tenant_id" = p."tenant_id" AND p."kind" = 'person' AND c."kind" IN ('agent', 'list') AND c."owner_user_id" IS NULL;
