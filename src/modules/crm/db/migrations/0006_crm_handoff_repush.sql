DROP INDEX "crm"."handoff_assignment_uq";--> statement-breakpoint
ALTER TABLE "crm"."handoff" ADD COLUMN "is_repush" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_assignment_uq" ON "crm"."handoff" USING btree ("tenant_id","assignment_id") WHERE not "crm"."handoff"."is_repush";