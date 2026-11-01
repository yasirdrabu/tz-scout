CREATE TABLE "routing"."lead_offer_change" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"from_offer_id" text,
	"to_offer_id" text,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "lead_offer_change_account_at_idx" ON "routing"."lead_offer_change" USING btree ("tenant_id","account_id","at" desc);--> statement-breakpoint
ALTER TABLE "routing"."lead_offer_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routing"."lead_offer_change" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "routing"."lead_offer_change" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
