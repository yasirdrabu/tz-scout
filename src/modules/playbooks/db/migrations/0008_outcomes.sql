CREATE TABLE "playbooks"."outcome" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plan_id" text,
	"template_id" text,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"amount_cents" bigint,
	"credited_step_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outcome_kind_valid" CHECK ("playbooks"."outcome"."kind" in ('reply', 'meeting', 'opportunity', 'won', 'lost', 'no_response'))
);
--> statement-breakpoint
ALTER TABLE "playbooks"."account_plan" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_ref_uq" ON "playbooks"."outcome" USING btree ("tenant_id","kind","ref");--> statement-breakpoint
CREATE INDEX "outcome_plan_idx" ON "playbooks"."outcome" USING btree ("tenant_id","plan_id");--> statement-breakpoint

ALTER TABLE "playbooks"."outcome" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."outcome" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."outcome" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
