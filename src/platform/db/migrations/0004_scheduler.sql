CREATE TABLE "platform"."schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"job_name" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_tenant_job_uq" ON "platform"."schedule" USING btree ("tenant_id","job_name");--> statement-breakpoint
CREATE INDEX "schedule_due_idx" ON "platform"."schedule" USING btree ("next_run_at") WHERE enabled;