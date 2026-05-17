CREATE TABLE IF NOT EXISTS "idempotency_keys" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"user_id" text,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_scope_idx" ON "idempotency_keys" USING btree ("key","method","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_unexpired_idx" ON "idempotency_keys" USING btree ("expires_at") WHERE "idempotency_keys"."response_status" is null;