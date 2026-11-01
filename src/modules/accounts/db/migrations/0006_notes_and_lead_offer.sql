CREATE TABLE "accounts"."account_note" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"body" text NOT NULL,
	"by_user_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "lead_offer_override_id" text;--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "note_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts"."account_note" ADD CONSTRAINT "account_note_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_note_account_at_idx" ON "accounts"."account_note" USING btree ("tenant_id","account_id","at");--> statement-breakpoint
ALTER TABLE "accounts"."account_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."account_note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."account_note" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
