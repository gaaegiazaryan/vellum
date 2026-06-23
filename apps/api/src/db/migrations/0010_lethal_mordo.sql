CREATE TABLE IF NOT EXISTS "bank_transactions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plaid_account_id" text NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"merchant_name" text,
	"description" text,
	"raw" jsonb NOT NULL,
	"journal_entry_id" text,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plaid_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plaid_item_id" text NOT NULL,
	"plaid_account_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"type" text NOT NULL,
	"subtype" text,
	"mask" text,
	"currency" text NOT NULL,
	"current_balance_minor" bigint,
	"ledger_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plaid_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"plaid_item_id" text NOT NULL,
	"access_token_cipher" text NOT NULL,
	"access_token_iv" text NOT NULL,
	"institution_id" text,
	"institution_name" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_sync_cursor" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_plaid_account_id_plaid_accounts_id_fk" FOREIGN KEY ("plaid_account_id") REFERENCES "public"."plaid_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "plaid_accounts" ADD CONSTRAINT "plaid_accounts_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bank_transactions_plaid_transaction_id_idx" ON "bank_transactions" USING btree ("plaid_transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_account_idx" ON "bank_transactions" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_occurred_idx" ON "bank_transactions" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_transactions_unmatched_idx" ON "bank_transactions" USING btree ("plaid_account_id") WHERE "bank_transactions"."journal_entry_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plaid_accounts_plaid_account_id_idx" ON "plaid_accounts" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plaid_accounts_item_idx" ON "plaid_accounts" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plaid_accounts_ledger_account_idx" ON "plaid_accounts" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plaid_items_plaid_item_id_idx" ON "plaid_items" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plaid_items_user_idx" ON "plaid_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plaid_items_last_sync_idx" ON "plaid_items" USING btree ("last_sync_at");