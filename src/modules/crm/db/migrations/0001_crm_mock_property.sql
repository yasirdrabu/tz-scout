CREATE TABLE "crm"."mock_property" (
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"group_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_property_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "crm"."mock_person" ADD COLUMN "qualified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."mock_property" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_property" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_property" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
