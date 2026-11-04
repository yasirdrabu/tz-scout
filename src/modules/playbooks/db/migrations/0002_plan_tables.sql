CREATE TABLE "playbooks"."account_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"tier" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"assignment_id" text NOT NULL,
	"seller_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"stop_when" text NOT NULL,
	"start_date" date NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_plan_status_valid" CHECK ("playbooks"."account_plan"."status" in ('active', 'paused', 'completed', 'stopped', 'abandoned')),
	CONSTRAINT "account_plan_tier_valid" CHECK ("playbooks"."account_plan"."tier" in ('act_now', 'good_fit', 'watch')),
	CONSTRAINT "account_plan_stop_when_valid" CHECK ("playbooks"."account_plan"."stop_when" in ('reply_or_meeting', 'meeting', 'never'))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."offer_playbook" (
	"tenant_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"tier" text NOT NULL,
	"template_id" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_playbook_tenant_id_offer_id_tier_pk" PRIMARY KEY("tenant_id","offer_id","tier"),
	CONSTRAINT "offer_playbook_tier_valid" CHECK ("playbooks"."offer_playbook"."tier" in ('act_now', 'good_fit', 'watch'))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."plan_change" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"step_id" text,
	"kind" text NOT NULL,
	"detail" jsonb,
	"by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks"."plan_step" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"template_step_id" text,
	"order" integer NOT NULL,
	"day" integer NOT NULL,
	"channel" text NOT NULL,
	"owner_role" text NOT NULL,
	"owner_user_id" text,
	"title" text NOT NULL,
	"detail" text,
	"target_person_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text,
	"note" text,
	"origin" text DEFAULT 'template' NOT NULL,
	"crm_task" boolean DEFAULT true NOT NULL,
	"subject" text,
	"body" text,
	CONSTRAINT "plan_step_status_valid" CHECK ("playbooks"."plan_step"."status" in ('todo', 'in_progress', 'done', 'skipped')),
	CONSTRAINT "plan_step_origin_valid" CHECK ("playbooks"."plan_step"."origin" in ('template', 'added', 'edited')),
	CONSTRAINT "plan_step_channel_valid" CHECK ("playbooks"."plan_step"."channel" in ('email', 'linkedin', 'call', 'meeting', 'task')),
	CONSTRAINT "plan_step_owner_role_valid" CHECK ("playbooks"."plan_step"."owner_role" in ('seller', 'leader', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."playbook_template" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"when_to_use" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"stop_when" text DEFAULT 'reply_or_meeting' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_template_status_valid" CHECK ("playbooks"."playbook_template"."status" in ('draft', 'active', 'archived')),
	CONSTRAINT "playbook_template_stop_when_valid" CHECK ("playbooks"."playbook_template"."stop_when" in ('reply_or_meeting', 'meeting', 'never'))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."template_step" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"order" integer NOT NULL,
	"day" integer NOT NULL,
	"channel" text NOT NULL,
	"owner_role" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"target_buying_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"crm_task" boolean DEFAULT true NOT NULL,
	"subject" text,
	"body" text,
	CONSTRAINT "template_step_day_valid" CHECK ("playbooks"."template_step"."day" between 0 and 365),
	CONSTRAINT "template_step_channel_valid" CHECK ("playbooks"."template_step"."channel" in ('email', 'linkedin', 'call', 'meeting', 'task')),
	CONSTRAINT "template_step_owner_role_valid" CHECK ("playbooks"."template_step"."owner_role" in ('seller', 'leader', 'operator'))
);
--> statement-breakpoint
ALTER TABLE "playbooks"."account_plan" ADD CONSTRAINT "account_plan_template_id_playbook_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "playbooks"."playbook_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."offer_playbook" ADD CONSTRAINT "offer_playbook_template_id_playbook_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "playbooks"."playbook_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."plan_change" ADD CONSTRAINT "plan_change_plan_id_account_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "playbooks"."account_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."plan_step" ADD CONSTRAINT "plan_step_plan_id_account_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "playbooks"."account_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks"."template_step" ADD CONSTRAINT "template_step_template_id_playbook_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "playbooks"."playbook_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_plan_open_uq" ON "playbooks"."account_plan" USING btree ("tenant_id","account_id") WHERE status in ('active', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "account_plan_assignment_uq" ON "playbooks"."account_plan" USING btree ("tenant_id","assignment_id");--> statement-breakpoint
CREATE INDEX "account_plan_account_idx" ON "playbooks"."account_plan" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX "plan_change_plan_idx" ON "playbooks"."plan_change" USING btree ("plan_id","at");--> statement-breakpoint
CREATE INDEX "plan_step_plan_idx" ON "playbooks"."plan_step" USING btree ("plan_id","order");--> statement-breakpoint
CREATE INDEX "plan_step_owner_idx" ON "playbooks"."plan_step" USING btree ("tenant_id","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "playbook_template_tenant_idx" ON "playbooks"."playbook_template" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "template_step_order_idx" ON "playbooks"."template_step" USING btree ("template_id","template_version","order");--> statement-breakpoint

ALTER TABLE "playbooks"."playbook_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."playbook_template" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."playbook_template" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

ALTER TABLE "playbooks"."template_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."template_step" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."template_step" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

ALTER TABLE "playbooks"."offer_playbook" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."offer_playbook" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."offer_playbook" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

ALTER TABLE "playbooks"."account_plan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."account_plan" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."account_plan" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

ALTER TABLE "playbooks"."plan_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."plan_step" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."plan_step" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint

ALTER TABLE "playbooks"."plan_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."plan_change" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."plan_change" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
