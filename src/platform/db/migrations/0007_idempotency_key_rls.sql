-- Idempotency keys hold tenant responses, so they are tenant-isolated like other tenant tables.
ALTER TABLE "platform"."idempotency_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform"."idempotency_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "platform"."idempotency_key" USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
