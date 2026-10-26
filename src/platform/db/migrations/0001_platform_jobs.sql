CREATE TABLE "platform"."dead_job" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"consumer_or_job" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"last_error" text NOT NULL,
	"attempts" integer NOT NULL,
	"dead_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."ping_result" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"handled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dead_job_dead_at_idx" ON "platform"."dead_job" USING btree ("dead_at");