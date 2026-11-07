-- Ruling 5 backfill: the least of the first completed or stopped change, no_reply_at, and, for an active plan with
-- at least one step and none open, its last done_at (updated_at when every step was skipped).
UPDATE "playbooks"."account_plan" p
SET "finished_at" = least(
  (SELECT min(c."at") FROM "playbooks"."plan_change" c
    WHERE c."tenant_id" = p."tenant_id" AND c."plan_id" = p."id" AND c."kind" IN ('completed', 'stopped')),
  p."no_reply_at",
  CASE
    WHEN p."status" = 'active'
      AND EXISTS (SELECT 1 FROM "playbooks"."plan_step" s WHERE s."tenant_id" = p."tenant_id" AND s."plan_id" = p."id")
      AND NOT EXISTS (SELECT 1 FROM "playbooks"."plan_step" s WHERE s."tenant_id" = p."tenant_id" AND s."plan_id" = p."id" AND s."status" IN ('todo', 'in_progress'))
    THEN coalesce((SELECT max(s."done_at") FROM "playbooks"."plan_step" s WHERE s."tenant_id" = p."tenant_id" AND s."plan_id" = p."id"), p."updated_at")
  END
)
WHERE p."finished_at" IS NULL;
