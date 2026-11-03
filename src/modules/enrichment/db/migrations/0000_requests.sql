CREATE TABLE "enrichment"."request" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_key" text NOT NULL,
	"connection_id" text,
	"connection_mode" text,
	"requested_by" text NOT NULL,
	"requested_by_label" text,
	"requesting_source_id" text,
	"reason" text,
	"watchers" text[] DEFAULT '{}'::text[] NOT NULL,
	"estimate" jsonb NOT NULL,
	"status" text NOT NULL,
	"waiting_reason" text,
	"decided_by" text,
	"decided_by_label" text,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_status_valid" CHECK ("enrichment"."request"."status" in ('flagged', 'approved', 'declined', 'cancelled', 'running', 'completed', 'partial', 'failed')),
	CONSTRAINT "request_kind_valid" CHECK ("enrichment"."request"."kind" in ('company_firmographics', 'people_for_roles', 'email_reveal', 'website_read', 'signals_refresh')),
	CONSTRAINT "request_connection_mode_valid" CHECK ("enrichment"."request"."connection_mode" is null or "enrichment"."request"."connection_mode" in ('mock', 'live'))
);
--> statement-breakpoint
CREATE INDEX "request_tenant_status_created_idx" ON "enrichment"."request" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "request_tenant_account_idx" ON "enrichment"."request" USING btree ("tenant_id","account_id");--> statement-breakpoint
ALTER TABLE "enrichment"."request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enrichment"."request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "enrichment"."request" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
