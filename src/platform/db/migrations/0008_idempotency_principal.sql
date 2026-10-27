-- Keys are now scoped to the caller. Nothing wrote to this table before, so no rows are lost.
DELETE FROM "platform"."idempotency_key";--> statement-breakpoint
ALTER TABLE "platform"."idempotency_key" ADD COLUMN "principal_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."idempotency_key" DROP CONSTRAINT "idempotency_key_tenant_id_key_pk";--> statement-breakpoint
ALTER TABLE "platform"."idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_principal_id_key_pk" PRIMARY KEY("tenant_id","principal_id","key");
