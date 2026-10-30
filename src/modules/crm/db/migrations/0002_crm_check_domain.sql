ALTER TABLE "crm"."company_check" ADD COLUMN "domain" text;--> statement-breakpoint
CREATE INDEX "company_check_domain_idx" ON "crm"."company_check" USING btree ("tenant_id","system","domain");