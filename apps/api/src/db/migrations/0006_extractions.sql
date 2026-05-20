CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'succeeded', 'failed', 'needs_review');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "extractions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_hash" text,
	"cost_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_estimated_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"confidence" numeric(4, 3),
	"status" "extraction_status" DEFAULT 'pending' NOT NULL,
	"receipt" jsonb,
	"error_code" text,
	"error_message" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_upload_idx" ON "extractions" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_created_by_idx" ON "extractions" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_status_idx" ON "extractions" USING btree ("status");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extractions" ADD CONSTRAINT "extractions_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extractions" ADD CONSTRAINT "extractions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
