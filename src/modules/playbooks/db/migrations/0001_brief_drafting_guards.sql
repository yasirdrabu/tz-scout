ALTER TABLE "playbooks"."brief" ADD COLUMN "frozen_by_assignment_id" text;--> statement-breakpoint
ALTER TABLE "playbooks"."brief" ADD COLUMN "manual_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "playbooks"."brief" ADD COLUMN "pending_include_edited" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "playbooks"."brief" ADD COLUMN "draft_job_id" text;--> statement-breakpoint
ALTER TABLE "playbooks"."brief" ADD COLUMN "draft_attempts" integer DEFAULT 0 NOT NULL;