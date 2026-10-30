CREATE TABLE "crm"."activity" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"handoff_id" text,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "activity_kind_valid" CHECK ("crm"."activity"."kind" in ('email', 'reply', 'call', 'meeting', 'task_done'))
);
--> statement-breakpoint
CREATE TABLE "crm"."company_check" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"system" text NOT NULL,
	"exists" boolean NOT NULL,
	"company_external_id" text,
	"owner_external_id" text,
	"owner_name" text,
	"lifecycle" text,
	"open_deals" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_check_tenant_id_account_id_system_pk" PRIMARY KEY("tenant_id","account_id","system")
);
--> statement-breakpoint
CREATE TABLE "crm"."setting" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"system" text DEFAULT 'hubspot' NOT NULL,
	"take_over_stale_ownership" boolean DEFAULT true NOT NULL,
	"push_new_people" boolean DEFAULT true NOT NULL,
	"follow_up_days" jsonb DEFAULT '[3,7,14]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_setting_follow_up_days_valid" CHECK (jsonb_typeof("crm"."setting"."follow_up_days") = 'array' and jsonb_array_length("crm"."setting"."follow_up_days") between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "crm"."deal" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"stage" text,
	"status" text NOT NULL,
	"amount_cents" bigint,
	"currency" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deal_status_valid" CHECK ("crm"."deal"."status" in ('open', 'won', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "crm"."field_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"system" text NOT NULL,
	"scout_field" text NOT NULL,
	"crm_object" text NOT NULL,
	"crm_property" text NOT NULL,
	"direction" text DEFAULT 'push' NOT NULL,
	"transform" text DEFAULT 'none' NOT NULL,
	"transform_config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "field_mapping_transform_valid" CHECK ("crm"."field_mapping"."transform" in ('none', 'cents_to_amount', 'date', 'enum_map'))
);
--> statement-breakpoint
CREATE TABLE "crm"."follow_through" (
	"tenant_id" text NOT NULL,
	"handoff_id" text NOT NULL,
	"baseline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone,
	"stage" text,
	"owner_external_id" text,
	CONSTRAINT "follow_through_tenant_id_handoff_id_pk" PRIMARY KEY("tenant_id","handoff_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"handoff_batch_id" text,
	"system" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ownership_action" text NOT NULL,
	"taken_from_owner" text,
	"owner_external_id" text,
	"company_external_id" text,
	"decision_reason" text,
	"last_error" text,
	"cancel_requested_at" timestamp with time zone,
	"undone" jsonb,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "handoff_status_valid" CHECK ("crm"."handoff"."status" in ('queued', 'running', 'completed', 'needs_decision', 'failed', 'cancelled')),
	CONSTRAINT "handoff_ownership_action_valid" CHECK ("crm"."handoff"."ownership_action" in ('assign', 'keep'))
);
--> statement-breakpoint
CREATE TABLE "crm"."handoff_batch" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bulk_key" text,
	"name" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."handoff_message" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"handoff_batch_id" text NOT NULL,
	"seller_user_id" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"copied_at" timestamp with time zone,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm"."link" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"scout_type" text NOT NULL,
	"scout_id" text NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"fingerprint" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_activity" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"company_external_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_owner_external_id" text,
	CONSTRAINT "mock_activity_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_company" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"location" text,
	"employees" integer,
	"description" text,
	"owner_external_id" text,
	"lifecycle" text DEFAULT 'lead' NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_company_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_deal" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"company_external_id" text NOT NULL,
	"name" text NOT NULL,
	"stage" text,
	"status" text DEFAULT 'open' NOT NULL,
	"amount_cents" bigint,
	"currency" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_deal_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_failure" (
	"tenant_id" text NOT NULL,
	"operation" text NOT NULL,
	"kind" text NOT NULL,
	"remaining" integer NOT NULL,
	CONSTRAINT "mock_failure_tenant_id_operation_pk" PRIMARY KEY("tenant_id","operation"),
	CONSTRAINT "mock_failure_kind_valid" CHECK ("crm"."mock_failure"."kind" in ('429', '500', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_note" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"company_external_id" text,
	"person_external_id" text,
	"html" text NOT NULL,
	"fingerprint" text NOT NULL,
	"owner_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_note_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_owner" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "mock_owner_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_person" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"company_external_id" text,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"linkedin" text,
	"owner_external_id" text,
	"lifecycle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_person_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mock_task" (
	"tenant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"company_external_id" text,
	"person_external_id" text,
	"subject" text NOT NULL,
	"body" text,
	"owner_external_id" text,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_task_tenant_id_external_id_pk" PRIMARY KEY("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."owner" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"system" text NOT NULL,
	"external_owner_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."property_setup" (
	"tenant_id" text NOT NULL,
	"system" text NOT NULL,
	"group_name" text NOT NULL,
	"created_properties" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"set_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	"set_up_by" text,
	CONSTRAINT "property_setup_tenant_id_system_pk" PRIMARY KEY("tenant_id","system")
);
--> statement-breakpoint
CREATE TABLE "crm"."task_link" (
	"tenant_id" text NOT NULL,
	"step_id" text NOT NULL,
	"system" text NOT NULL,
	"external_task_id" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	CONSTRAINT "task_link_tenant_id_system_step_id_pk" PRIMARY KEY("tenant_id","system","step_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."webhook_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_uq" ON "crm"."activity" USING btree ("tenant_id","system","external_id");--> statement-breakpoint
CREATE INDEX "activity_account_idx" ON "crm"."activity" USING btree ("tenant_id","account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deal_uq" ON "crm"."deal" USING btree ("tenant_id","system","external_id");--> statement-breakpoint
CREATE INDEX "deal_account_idx" ON "crm"."deal" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_mapping_uq" ON "crm"."field_mapping" USING btree ("tenant_id","system","scout_field","crm_object");--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_assignment_uq" ON "crm"."handoff" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
CREATE INDEX "handoff_account_idx" ON "crm"."handoff" USING btree ("tenant_id","account_id","queued_at");--> statement-breakpoint
CREATE INDEX "handoff_batch_idx" ON "crm"."handoff" USING btree ("tenant_id","handoff_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_batch_bulk_key_uq" ON "crm"."handoff_batch" USING btree ("tenant_id","bulk_key") WHERE "crm"."handoff_batch"."bulk_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_message_uq" ON "crm"."handoff_message" USING btree ("tenant_id","handoff_batch_id","seller_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "link_uq" ON "crm"."link" USING btree ("tenant_id","system","scout_type","scout_id","external_id");--> statement-breakpoint
CREATE INDEX "link_external_idx" ON "crm"."link" USING btree ("tenant_id","system","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mock_company_domain_uq" ON "crm"."mock_company" USING btree ("tenant_id","domain");--> statement-breakpoint
CREATE INDEX "mock_person_email_idx" ON "crm"."mock_person" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_uq" ON "crm"."owner" USING btree ("tenant_id","system","external_owner_id");--> statement-breakpoint
CREATE INDEX "webhook_receipt_idx" ON "crm"."webhook_receipt" USING btree ("tenant_id","received_at");--> statement-breakpoint
ALTER TABLE "crm"."activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."activity" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."company_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."company_check" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."company_check" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."setting" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."deal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."deal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."deal" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."field_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."field_mapping" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."field_mapping" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."follow_through" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."follow_through" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."follow_through" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."handoff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."handoff" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."handoff" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."handoff_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."handoff_batch" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."handoff_batch" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."handoff_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."handoff_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."handoff_message" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."link" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_activity" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_company" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_company" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_company" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_deal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_deal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_deal" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_failure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_failure" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_failure" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_note" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_owner" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_owner" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_owner" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_person" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_person" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_person" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."mock_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."mock_task" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."mock_task" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."owner" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."owner" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."owner" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."property_setup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."property_setup" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."property_setup" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."task_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."task_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."task_link" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "crm"."webhook_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm"."webhook_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "crm"."webhook_receipt" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint
