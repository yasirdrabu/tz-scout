CREATE TABLE "routing"."enrichment_open" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"request_id" text NOT NULL,
	"requested_by_label" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_open_tenant_id_request_id_pk" PRIMARY KEY("tenant_id","request_id")
);
--> statement-breakpoint
CREATE INDEX "enrichment_open_account_idx" ON "routing"."enrichment_open" USING btree ("tenant_id","account_id");--> statement-breakpoint
ALTER TABLE "routing"."enrichment_open" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."enrichment_open" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."enrichment_open" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
