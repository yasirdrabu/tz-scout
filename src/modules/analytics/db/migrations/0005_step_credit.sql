CREATE TABLE "analytics"."step_credit" (
	"tenant_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"outcome_kind" text NOT NULL,
	"step_id" text,
	"step_type" text,
	"playbook_template_id" text,
	"practice_id" text,
	"offer_id" text,
	"account_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "step_credit_outcome_step_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","outcome_id","step_id"),
	CONSTRAINT "step_credit_kind_valid" CHECK ("analytics"."step_credit"."outcome_kind" in ('reply', 'meeting', 'opportunity', 'won', 'lost', 'no_response')),
	CONSTRAINT "step_credit_type_valid" CHECK ("analytics"."step_credit"."step_type" is null or "analytics"."step_credit"."step_type" in ('email', 'linkedin', 'call', 'meeting', 'task'))
);
--> statement-breakpoint
CREATE INDEX "step_credit_tenant_occurred_idx" ON "analytics"."step_credit" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "step_credit_account_idx" ON "analytics"."step_credit" USING btree ("tenant_id","account_id");--> statement-breakpoint
ALTER TABLE "analytics"."step_credit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics"."step_credit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "analytics"."step_credit" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
