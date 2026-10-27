CREATE TABLE "intake"."arrival" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"batch_id" text,
	"person_source_id" text,
	"agent_source_id" text,
	"vendor_source_id" text,
	"closest_source_id" text NOT NULL,
	"principal" text NOT NULL,
	"channel" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contract_version" text DEFAULT 'arrival.v1' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"external_ref" text,
	"target_account_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"waiting_on" text,
	"waiting_since" timestamp with time zone,
	"reject_reason" text,
	"reject_detail" text,
	"account_id" text,
	"resolution" text,
	"duplicate_candidates" jsonb,
	"resolution_input" jsonb,
	"normalised" jsonb,
	"lock_key" text,
	"steps" text[] DEFAULT '{}'::text[] NOT NULL,
	"warm_intro_id" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "intake"."batch" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"person_source_id" text,
	"agent_source_id" text,
	"vendor_source_id" text,
	"principal" text NOT NULL,
	"name" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"criteria" jsonb,
	"metadata" jsonb,
	"item_count" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake"."batch_file" (
	"tenant_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_file_batch_id_storage_key_pk" PRIMARY KEY("batch_id","storage_key")
);
--> statement-breakpoint
CREATE TABLE "intake"."column_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_id" text NOT NULL,
	"header_signature" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake"."file_blob" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"content" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake"."file_import" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"batch_id" text,
	"source_id" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"layout" text,
	"headers" jsonb,
	"row_count" integer,
	"mapping" jsonb,
	"mapping_origin" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake"."relationship_default" (
	"tenant_id" text NOT NULL,
	"relationship_key" text NOT NULL,
	"label" text NOT NULL,
	"points" integer NOT NULL,
	CONSTRAINT "relationship_default_tenant_id_relationship_key_pk" PRIMARY KEY("tenant_id","relationship_key")
);
--> statement-breakpoint
CREATE TABLE "intake"."source" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"initial_review_status_key" text,
	"daily_arrival_cap" integer DEFAULT 500 NOT NULL,
	"trust" numeric(5, 4) DEFAULT 0.6 NOT NULL,
	"trust_updated_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake"."warm_intro" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"arrival_id" text NOT NULL,
	"account_id" text NOT NULL,
	"introducer_user_id" text,
	"introducer_name" text,
	"introducer_email" text,
	"relationship_text" text,
	"relationship_key" text NOT NULL,
	"note" text,
	"points" integer NOT NULL,
	"effective_points" integer NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake"."warm_intro_rule" (
	"tenant_id" text NOT NULL,
	"introducer_user_id" text,
	"introducer_email" text,
	"relationship_key" text NOT NULL,
	"points" integer NOT NULL,
	CONSTRAINT "warm_intro_rule_one_introducer" CHECK (("intake"."warm_intro_rule"."introducer_user_id" is null) <> ("intake"."warm_intro_rule"."introducer_email" is null))
);
--> statement-breakpoint
ALTER TABLE "intake"."arrival" ADD CONSTRAINT "arrival_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "intake"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."batch_file" ADD CONSTRAINT "batch_file_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "intake"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."file_import" ADD CONSTRAINT "file_import_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "intake"."batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."source" ADD CONSTRAINT "source_parent_id_source_id_fk" FOREIGN KEY ("parent_id") REFERENCES "intake"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro" ADD CONSTRAINT "warm_intro_arrival_id_arrival_id_fk" FOREIGN KEY ("arrival_id") REFERENCES "intake"."arrival"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arrival_tenant_source_ref_uq" ON "intake"."arrival" USING btree ("tenant_id","closest_source_id","external_ref") WHERE external_ref is not null;--> statement-breakpoint
CREATE INDEX "arrival_tenant_source_received_idx" ON "intake"."arrival" USING btree ("tenant_id","closest_source_id","received_at");--> statement-breakpoint
CREATE INDEX "arrival_tenant_status_waiting_idx" ON "intake"."arrival" USING btree ("tenant_id","status","waiting_on");--> statement-breakpoint
CREATE INDEX "arrival_tenant_batch_idx" ON "intake"."arrival" USING btree ("tenant_id","batch_id");--> statement-breakpoint
CREATE INDEX "arrival_tenant_account_idx" ON "intake"."arrival" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "column_mapping_tenant_source_sig_uq" ON "intake"."column_mapping" USING btree ("tenant_id","source_id","header_signature");--> statement-breakpoint
CREATE INDEX "file_import_tenant_source_idx" ON "intake"."file_import" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_tenant_person_user_uq" ON "intake"."source" USING btree ("tenant_id","user_id") WHERE kind = 'person' and user_id is not null;--> statement-breakpoint
CREATE INDEX "source_tenant_parent_idx" ON "intake"."source" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warm_intro_tenant_arrival_uq" ON "intake"."warm_intro" USING btree ("tenant_id","arrival_id");--> statement-breakpoint
CREATE INDEX "warm_intro_tenant_account_idx" ON "intake"."warm_intro" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warm_intro_rule_user_uq" ON "intake"."warm_intro_rule" USING btree ("tenant_id","introducer_user_id","relationship_key") WHERE introducer_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "warm_intro_rule_email_uq" ON "intake"."warm_intro_rule" USING btree ("tenant_id","introducer_email","relationship_key") WHERE introducer_email is not null;--> statement-breakpoint
ALTER TABLE "intake"."source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."source" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."batch" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."batch" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."arrival" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."arrival" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."arrival" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."batch_file" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."batch_file" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."batch_file" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."file_blob" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."file_blob" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."file_blob" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."file_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."file_import" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."file_import" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."column_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."column_mapping" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."column_mapping" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."warm_intro" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."warm_intro" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."warm_intro_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."warm_intro_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."warm_intro_rule" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "intake"."relationship_default" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intake"."relationship_default" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "intake"."relationship_default" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE FUNCTION "intake"."arrival_payload_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
    RAISE EXCEPTION 'intake.arrival payload is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER arrival_payload_immutable BEFORE UPDATE ON "intake"."arrival" FOR EACH ROW EXECUTE FUNCTION "intake"."arrival_payload_immutable"();
--> statement-breakpoint
REVOKE DELETE ON "intake"."arrival" FROM scout_app;
