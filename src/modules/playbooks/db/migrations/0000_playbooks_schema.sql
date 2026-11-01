CREATE TABLE "playbooks"."brief" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"offer_id" text,
	"mode" text,
	"ai_run_id" text,
	"recommendation_headline" text,
	"recommendation_detail" text,
	"recommendation_origin" text,
	"opener_subject" text,
	"opener_body" text,
	"opener_origin" text,
	"who_first_person_id" text,
	"who_first_title" text,
	"who_first_reason" text,
	"draft_state" text DEFAULT 'not_drafted' NOT NULL,
	"requested_seq" integer DEFAULT 0 NOT NULL,
	"drafted_seq" integer DEFAULT 0 NOT NULL,
	"frozen_at" timestamp with time zone,
	"last_error" text,
	"drafted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_tenant_id_account_id_pk" PRIMARY KEY("tenant_id","account_id"),
	CONSTRAINT "brief_draft_state_valid" CHECK ("playbooks"."brief"."draft_state" in ('not_drafted', 'drafting', 'ready')),
	CONSTRAINT "brief_mode_valid" CHECK ("playbooks"."brief"."mode" is null or "playbooks"."brief"."mode" in ('live', 'mock', 'rules'))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."brief_section" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"key" text NOT NULL,
	"body" text NOT NULL,
	"citations" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" text NOT NULL,
	"mode" text,
	"ai_run_id" text,
	"offer_id" text,
	"edited_by" text,
	"edited_by_name" text,
	"edited_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_section_tenant_id_account_id_key_pk" PRIMARY KEY("tenant_id","account_id","key"),
	CONSTRAINT "brief_section_origin_valid" CHECK ("playbooks"."brief_section"."origin" in ('ai', 'rules', 'human'))
);
--> statement-breakpoint
CREATE TABLE "playbooks"."brief_section_history" (
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"key" text NOT NULL,
	"body" text NOT NULL,
	"citations" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" text NOT NULL,
	"mode" text,
	"ai_run_id" text,
	"offer_id" text,
	"edited_by" text,
	"edited_by_name" text,
	"edited_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_section_history_tenant_id_account_id_key_version_pk" PRIMARY KEY("tenant_id","account_id","key","version")
);
--> statement-breakpoint
ALTER TABLE "playbooks"."brief" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."brief" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."brief" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "playbooks"."brief_section" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."brief_section" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."brief_section" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));--> statement-breakpoint

ALTER TABLE "playbooks"."brief_section_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "playbooks"."brief_section_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "playbooks"."brief_section_history" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
