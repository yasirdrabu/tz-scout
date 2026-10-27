CREATE TABLE "offers"."case_study" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"client_name" text,
	"industry" text,
	"result" text,
	"link_url" text,
	"public" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers"."offer" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"practice_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"promise" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"price_min_cents" bigint,
	"price_max_cents" bigint,
	"gross_margin" numeric(6, 4),
	"typical_deal_cents" bigint,
	"expansion_rate" numeric(6, 4),
	"expansion_value_cents" bigint,
	"sales_cycle_days" integer,
	"target_titles" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_buying_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"company_size_min" integer,
	"company_size_max" integer,
	"revenue_min_cents" bigint,
	"revenue_max_cents" bigint,
	"industries" text[] DEFAULT '{}'::text[] NOT NULL,
	"regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"proof_points" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"origin" text DEFAULT 'manual' NOT NULL,
	"draft_source" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers"."offer_case_study" (
	"tenant_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"case_study_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_case_study_offer_id_case_study_id_pk" PRIMARY KEY("offer_id","case_study_id")
);
--> statement-breakpoint
CREATE TABLE "offers"."practice" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_playbook_id" text,
	"brief_template_key" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers"."offer" ADD CONSTRAINT "offer_practice_id_practice_id_fk" FOREIGN KEY ("practice_id") REFERENCES "offers"."practice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers"."offer_case_study" ADD CONSTRAINT "offer_case_study_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "offers"."offer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers"."offer_case_study" ADD CONSTRAINT "offer_case_study_case_study_id_case_study_id_fk" FOREIGN KEY ("case_study_id") REFERENCES "offers"."case_study"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_study_tenant_idx" ON "offers"."case_study" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_tenant_slug_uq" ON "offers"."offer" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "offer_tenant_practice_idx" ON "offers"."offer" USING btree ("tenant_id","practice_id");--> statement-breakpoint
CREATE INDEX "offer_case_study_case_idx" ON "offers"."offer_case_study" USING btree ("tenant_id","case_study_id");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_tenant_slug_uq" ON "offers"."practice" USING btree ("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "offers"."practice" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers"."practice" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "offers"."practice" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "offers"."offer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers"."offer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "offers"."offer" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "offers"."case_study" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers"."case_study" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "offers"."case_study" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
--> statement-breakpoint
ALTER TABLE "offers"."offer_case_study" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offers"."offer_case_study" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "offers"."offer_case_study" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
