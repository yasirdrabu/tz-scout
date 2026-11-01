ALTER TABLE "crm"."company_check" ADD COLUMN "open_deal_name" text;--> statement-breakpoint
ALTER TABLE "crm"."company_check" ADD COLUMN "open_deal_amount_cents" bigint;--> statement-breakpoint
ALTER TABLE "crm"."company_check" ADD COLUMN "open_deal_currency" text;--> statement-breakpoint
ALTER TABLE "crm"."company_check" ADD COLUMN "open_deal_last_activity_at" timestamp with time zone;