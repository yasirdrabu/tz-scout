ALTER TABLE "routing"."decline_reason_def" ADD COLUMN "note_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routing"."decline_reason_def" ADD COLUMN "order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routing"."review_status_def" ADD COLUMN "color" text DEFAULT 'gray' NOT NULL;--> statement-breakpoint
ALTER TABLE "routing"."review_status_def" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "routing"."review_status_def" ADD COLUMN "set_by" text DEFAULT 'reviewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "routing"."review_status_def" ADD COLUMN "flag_after_hours" integer;--> statement-breakpoint
-- Data: every existing tenant gets the mockup's words (Decision 2, Open question 1). A label someone
-- already changed is left alone. Colors follow the old tones.
UPDATE "routing"."review_status_def" SET "color" = CASE "tone" WHEN 'near' THEN 'amber' WHEN 'good' THEN 'green' WHEN 'bad' THEN 'red' ELSE 'gray' END;--> statement-breakpoint
UPDATE "routing"."review_status_def" SET "label" = 'Ready for review', "color" = 'plum', "set_by" = 'scout', "flag_after_hours" = 48, "description" = 'New from a source. Nobody has looked at it yet.' WHERE "key" = 'unvetted' AND "label" = 'Unvetted';--> statement-breakpoint
UPDATE "routing"."review_status_def" SET "label" = 'In review', "color" = 'amber', "set_by" = 'reviewer', "flag_after_hours" = 24, "description" = 'Someone is looking at it before it goes to a seller.' WHERE "key" = 'needs_review' AND "label" = 'Needs review';--> statement-breakpoint
UPDATE "routing"."review_status_def" SET "label" = 'Approved', "color" = 'green', "set_by" = 'reviewer', "description" = 'Approved and ready for a seller.' WHERE "key" = 'reviewed' AND "label" = 'Reviewed';--> statement-breakpoint
UPDATE "routing"."review_status_def" SET "label" = 'Not pursued', "color" = 'red', "set_by" = 'reviewer', "description" = 'We decided not to go after it, with a reason.' WHERE "key" = 'declined' AND "label" = 'Declined';--> statement-breakpoint
INSERT INTO "routing"."review_status_def" ("id", "tenant_id", "key", "label", "order", "counts_as_reviewed", "is_declined", "is_initial", "returns_to_source", "color", "set_by", "description")
SELECT 'rsd_' || upper(replace(gen_random_uuid()::text, '-', '')), t."tenant_id", 'sent_back', 'Sent back to source', 5, true, false, false, true, 'gray', 'reviewer', 'Returned to the source with a reason, to fix and send again.'
FROM (SELECT DISTINCT "tenant_id" FROM "routing"."review_status_def") t
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "routing"."decline_reason_def" SET "note_required" = true WHERE "key" = 'other';--> statement-breakpoint
UPDATE "routing"."decline_reason_def" r SET "order" = o."order"
FROM (VALUES ('not_a_fit', 1), ('already_a_customer', 2), ('open_deal_elsewhere', 3), ('duplicate', 4), ('bad_data', 5), ('wrong_timing', 6), ('not_my_territory', 7), ('too_much_on_my_plate', 8), ('already_talking_to_them', 9), ('other', 10)) AS o("key", "order")
WHERE r."key" = o."key";--> statement-breakpoint
INSERT INTO "routing"."decline_reason_def" ("id", "tenant_id", "key", "label", "applies_to", "note_required", "order")
SELECT 'drd_' || upper(replace(gen_random_uuid()::text, '-', '')), t."tenant_id", r."key", r."label", 'send_back', false, r."order"
FROM (SELECT DISTINCT "tenant_id" FROM "routing"."decline_reason_def") t
CROSS JOIN (VALUES ('not_our_kind_of_customer', 'Not our kind of customer', 11), ('existing_customer', 'Already a customer', 12), ('duplicate_account', 'Duplicate of another account', 13), ('bad_contact', 'Bad or missing contact', 14), ('wrong_practice', 'Wrong practice', 15)) AS r("key", "label", "order")
ON CONFLICT DO NOTHING;
