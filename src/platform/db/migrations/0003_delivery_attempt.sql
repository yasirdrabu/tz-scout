CREATE TABLE "platform"."delivery_attempt" (
	"consumer_name" text NOT NULL,
	"event_id" text NOT NULL,
	"run_attempts" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempt_consumer_name_event_id_pk" PRIMARY KEY("consumer_name","event_id")
);
