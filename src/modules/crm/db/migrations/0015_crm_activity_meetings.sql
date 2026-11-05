ALTER TABLE "crm"."activity" ADD COLUMN "contacts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."activity" ADD COLUMN "actor_owner_external_id" text;--> statement-breakpoint
ALTER TABLE "crm"."activity" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "crm"."activity" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."activity" ADD COLUMN "end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."activity" ADD COLUMN "status" text;