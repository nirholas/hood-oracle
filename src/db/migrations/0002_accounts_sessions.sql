CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_address" text NOT NULL,
	"account_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"factory_address" text NOT NULL,
	"deployed_tx" text,
	"operator_address" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"label" text,
	"policy" jsonb,
	"revoked_reason" text,
	"eth_balance_wei" numeric(40, 0) DEFAULT '0' NOT NULL,
	"weth_balance_wei" numeric(40, 0) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"secret_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"token_hash" text NOT NULL,
	"chain_id" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent_hash" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "arms" ADD COLUMN "account_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_address_uidx" ON "accounts" USING btree ("account_address","chain_id");--> statement-breakpoint
CREATE INDEX "accounts_owner_idx" ON "accounts" USING btree ("owner_address","chain_id");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status","last_synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_nonces_nonce_uidx" ON "auth_nonces" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "auth_nonces_expiry_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uidx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_address_idx" ON "sessions" USING btree ("address","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "arms" ADD CONSTRAINT "arms_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arms_account_idx" ON "arms" USING btree ("account_id");