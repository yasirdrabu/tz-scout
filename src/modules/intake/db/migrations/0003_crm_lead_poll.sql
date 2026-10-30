CREATE TABLE "intake"."crm_lead_poll" (
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"polled_until" timestamp with time zone NOT NULL,
	CONSTRAINT "crm_lead_poll_tenant_id_connection_id_pk" PRIMARY KEY("tenant_id","connection_id")
);
--> statement-breakpoint
ALTER TABLE "intake"."arrival" ADD COLUMN "external_ids" jsonb;--> statement-breakpoint
ALTER TABLE "intake"."crm_lead_poll" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."crm_lead_poll" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."crm_lead_poll" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
