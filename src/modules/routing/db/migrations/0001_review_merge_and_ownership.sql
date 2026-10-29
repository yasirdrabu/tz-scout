ALTER TABLE "routing"."account_review" ADD COLUMN "merged_into" text;--> statement-breakpoint
ALTER TABLE "routing"."assignment" ADD COLUMN "ownership_decision" text DEFAULT 'assign' NOT NULL;