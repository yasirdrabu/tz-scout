CREATE TABLE "intake"."source_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_id" text NOT NULL,
	"arrival_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason_key" text,
	"note" text,
	"cause_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intake"."source_feedback" ADD CONSTRAINT "source_feedback_arrival_id_arrival_id_fk" FOREIGN KEY ("arrival_id") REFERENCES "intake"."arrival"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_feedback_cause_uq" ON "intake"."source_feedback" USING btree ("tenant_id","source_id","arrival_id","kind","cause_event_id");--> statement-breakpoint
CREATE INDEX "source_feedback_tenant_source_created_idx" ON "intake"."source_feedback" USING btree ("tenant_id","source_id","created_at","id");--> statement-breakpoint
CREATE INDEX "source_feedback_tenant_arrival_idx" ON "intake"."source_feedback" USING btree ("tenant_id","arrival_id");--> statement-breakpoint
ALTER TABLE "intake"."source_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."source_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."source_feedback" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
