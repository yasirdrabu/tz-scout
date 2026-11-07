CREATE TABLE "intake"."source_trust_history" (
	"tenant_id" text NOT NULL,
	"source_id" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"trust" numeric(5, 4) NOT NULL,
	"sample_size" integer NOT NULL,
	"won" integer NOT NULL,
	"inputs" jsonb NOT NULL,
	CONSTRAINT "source_trust_history_tenant_id_source_id_computed_at_pk" PRIMARY KEY("tenant_id","source_id","computed_at")
);
--> statement-breakpoint
ALTER TABLE "intake"."source" ADD COLUMN "trust_published" numeric(5, 4) DEFAULT 0.6 NOT NULL;--> statement-breakpoint
ALTER TABLE "intake"."source" ADD COLUMN "trust_sample" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "intake"."source" ADD COLUMN "trust_won" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "intake"."source_trust_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."source_trust_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."source_trust_history" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
