DROP INDEX "tenancy"."api_key_prefix_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_prefix_idx" ON "tenancy"."api_key" USING btree ("prefix");