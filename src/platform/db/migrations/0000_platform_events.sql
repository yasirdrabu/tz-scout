CREATE TABLE "platform"."idempotency_key" (
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"nats_subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "platform"."processed_event" (
	"consumer_name" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_event_consumer_name_event_id_pk" PRIMARY KEY("consumer_name","event_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_unsent_idx" ON "platform"."outbox" USING btree ("seq") WHERE "sent_at" is null;--> statement-breakpoint
CREATE FUNCTION "platform"."notify_outbox"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('scout_outbox', ''); RETURN NULL; END $$;
--> statement-breakpoint
CREATE TRIGGER "outbox_notify" AFTER INSERT ON "platform"."outbox" FOR EACH STATEMENT EXECUTE FUNCTION "platform"."notify_outbox"();
