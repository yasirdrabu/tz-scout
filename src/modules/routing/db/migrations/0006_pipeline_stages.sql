CREATE TABLE "routing"."pipeline_stage" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"trigger" text NOT NULL,
	"hubspot_stage" text,
	"quarter_target" integer,
	"locked" text,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pipeline_stage_kind" CHECK ("routing"."pipeline_stage"."kind" in ('flow', 'exit'))
);
--> statement-breakpoint
ALTER TABLE "routing"."stage_change" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "routing"."stage_change" ADD COLUMN "to_name" text;--> statement-breakpoint
ALTER TABLE "routing"."stage_change" ADD COLUMN "by" text;--> statement-breakpoint
ALTER TABLE "routing"."stage_change" ADD COLUMN "note" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_key_uq" ON "routing"."pipeline_stage" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_name_uq" ON "routing"."pipeline_stage" USING btree ("tenant_id",lower("name")) WHERE "routing"."pipeline_stage"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "routing"."pipeline_stage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."pipeline_stage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."pipeline_stage" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
-- Data: every existing tenant gets the default stages (REV-E5 "Defaults") under today's keys, so stored stages need no rewrite.
INSERT INTO "routing"."pipeline_stage" ("id", "tenant_id", "key", "name", "kind", "position", "trigger", "hubspot_stage", "locked")
SELECT 'pst_' || upper(replace(gen_random_uuid()::text, '-', '')), t."tenant_id", d."key", d."name", d."kind", d."position", d."trigger", d."hubspot_stage", d."locked"
FROM (SELECT DISTINCT "tenant_id" FROM "routing"."review_status_def") t
CROSS JOIN (VALUES
  ('arrived', 'Sent', 'flow', 0, 'source_creates', NULL, 'first'),
  ('reviewed', 'Reviewed', 'flow', 1, 'reviewer_sets_tier', NULL, NULL),
  ('assigned', 'Assigned', 'flow', 2, 'ae_accepts', NULL, NULL),
  ('engaged', 'Engaged', 'flow', 3, 'reply_or_meeting', NULL, NULL),
  ('opportunity', 'Opportunity', 'flow', 4, 'deal_created', NULL, NULL),
  ('won', 'Won', 'flow', 5, 'deal_closed_won', 'closedwon', 'won'),
  ('declined', 'Disqualified', 'exit', 0, 'reviewer_rejects', NULL, NULL),
  ('back_to_nurture', 'Back to nurture', 'exit', 1, 'playbook_no_reply', NULL, NULL),
  ('lost', 'Lost', 'exit', 2, 'deal_closed_lost', 'closedlost', NULL)
) AS d("key", "name", "kind", "position", "trigger", "hubspot_stage", "locked")
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Data: history keeps the names it had until now (the old labels).
UPDATE "routing"."stage_change" SET
  "from_name" = CASE "from_stage" WHEN 'arrived' THEN 'Arrived' WHEN 'reviewed' THEN 'Reviewed' WHEN 'assigned' THEN 'Assigned' WHEN 'engaged' THEN 'Engaged' WHEN 'opportunity' THEN 'Opportunity' WHEN 'won' THEN 'Won' WHEN 'lost' THEN 'Lost' WHEN 'declined' THEN 'Not pursued' ELSE "from_stage" END,
  "to_name" = CASE "to_stage" WHEN 'arrived' THEN 'Arrived' WHEN 'reviewed' THEN 'Reviewed' WHEN 'assigned' THEN 'Assigned' WHEN 'engaged' THEN 'Engaged' WHEN 'opportunity' THEN 'Opportunity' WHEN 'won' THEN 'Won' WHEN 'lost' THEN 'Lost' WHEN 'declined' THEN 'Not pursued' ELSE "to_stage" END;
