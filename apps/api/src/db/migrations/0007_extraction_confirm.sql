ALTER TABLE "extractions" ADD COLUMN IF NOT EXISTS "journal_entry_id" text;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN IF NOT EXISTS "confirmed_by_id" text;--> statement-breakpoint
ALTER TABLE "extractions" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extractions_journal_entry_idx" ON "extractions" USING btree ("journal_entry_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extractions" ADD CONSTRAINT "extractions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "extractions" ADD CONSTRAINT "extractions_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
