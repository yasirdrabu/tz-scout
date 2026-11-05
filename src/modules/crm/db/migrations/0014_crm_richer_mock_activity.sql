ALTER TABLE "crm"."mock_activity" ADD COLUMN "contact_external_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."mock_activity" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "crm"."mock_activity" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."mock_activity" ADD COLUMN "end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."mock_activity" ADD COLUMN "status" text;