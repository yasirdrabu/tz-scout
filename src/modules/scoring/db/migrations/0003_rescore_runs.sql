CREATE TABLE "scoring"."rescore_run" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"cause" text NOT NULL,
	"filter" jsonb NOT NULL,
	"requested_by" text,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"paging_done" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scoring"."rescore_run_part" (
	"tenant_id" text NOT NULL,
	"run_id" text NOT NULL,
	"part_key" text NOT NULL,
	CONSTRAINT "rescore_run_part_tenant_id_run_id_part_key_pk" PRIMARY KEY("tenant_id","run_id","part_key")
);
--> statement-breakpoint
CREATE INDEX "rescore_run_started_idx" ON "scoring"."rescore_run" USING btree ("tenant_id","started_at" desc);--> statement-breakpoint
ALTER TABLE "scoring"."rescore_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scoring"."rescore_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scoring"."rescore_run" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
ALTER TABLE "scoring"."rescore_run_part" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scoring"."rescore_run_part" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scoring"."rescore_run_part" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));