CREATE TABLE "accounts"."conflict" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"person_id" text,
	"key" text NOT NULL,
	"fact_ids" text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"kept_fact_id" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"note" text,
	"explanation" text,
	"explanation_fact_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts"."account_summary" ADD COLUMN "open_conflict_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts"."conflict" ADD CONSTRAINT "conflict_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts"."conflict" ADD CONSTRAINT "conflict_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "accounts"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conflict_tenant_account_status_idx" ON "accounts"."conflict" USING btree ("tenant_id","account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "conflict_open_uq" ON "accounts"."conflict" USING btree ("tenant_id","account_id",coalesce("person_id", ''),"key") WHERE status = 'open';--> statement-breakpoint
ALTER TABLE "accounts"."conflict" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts"."conflict" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "accounts"."conflict" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
