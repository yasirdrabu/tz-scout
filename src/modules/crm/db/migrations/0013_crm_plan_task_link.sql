ALTER TABLE "crm"."task_link" ADD COLUMN "account_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."task_link" ADD COLUMN "plan_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."task_link" ADD COLUMN "fingerprint" text;--> statement-breakpoint
CREATE INDEX "task_link_external_idx" ON "crm"."task_link" USING btree ("tenant_id","system","external_task_id");--> statement-breakpoint
ALTER TABLE "crm"."task_link" ADD CONSTRAINT "task_link_status_valid" CHECK ("crm"."task_link"."status" in ('open', 'closed', 'done'));