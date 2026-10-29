CREATE TABLE "offers"."signal_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"weight" integer NOT NULL,
	"match" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_value" numeric(8, 4),
	"why" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers"."signal_rule" ADD CONSTRAINT "signal_rule_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "offers"."offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_rule_tenant_offer_idx" ON "offers"."signal_rule" USING btree ("tenant_id","offer_id","sort");--> statement-breakpoint
ALTER TABLE "offers"."signal_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers"."signal_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "offers"."signal_rule" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
