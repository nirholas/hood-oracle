CREATE TABLE "arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'simulate' NOT NULL,
	"trigger" text DEFAULT 'new_launch' NOT NULL,
	"launchpads" jsonb DEFAULT '["noxa","odyssey"]'::jsonb NOT NULL,
	"per_trade_wei" numeric(40, 0) DEFAULT '0' NOT NULL,
	"daily_budget_wei" numeric(40, 0) DEFAULT '0' NOT NULL,
	"max_concurrent_positions" integer DEFAULT 1 NOT NULL,
	"cooldown_seconds" integer DEFAULT 0 NOT NULL,
	"slippage_bps" integer DEFAULT 500 NOT NULL,
	"max_price_impact_pct" real DEFAULT 10 NOT NULL,
	"firewall_level" text DEFAULT 'block' NOT NULL,
	"buy_delay_ms" integer DEFAULT 0 NOT NULL,
	"min_oracle_score" real,
	"max_rug_risk" real,
	"min_unique_buyers" integer,
	"max_creator_launches" integer,
	"max_deployer_pct" real,
	"max_bundle_score" real,
	"max_concentration_top1" real,
	"min_market_cap_eth" real,
	"max_market_cap_eth" real,
	"require_socials" boolean DEFAULT false NOT NULL,
	"avoid_dev_dump" boolean DEFAULT true NOT NULL,
	"allowed_categories" jsonb,
	"stop_loss_pct" real DEFAULT 30 NOT NULL,
	"take_profit_pct" real,
	"trailing_stop_pct" real,
	"max_hold_seconds" integer DEFAULT 1800 NOT NULL,
	"liquidity_decay_seconds" integer,
	"initials_out_multiple" real,
	"moonbag_min_pct" real DEFAULT 15 NOT NULL,
	"moonbag_always" boolean DEFAULT false NOT NULL,
	"decision_mode" text DEFAULT 'rules' NOT NULL,
	"llm_min_confidence" real,
	"auto_optimize" boolean DEFAULT false NOT NULL,
	"autonomy_tier" text DEFAULT 'standard' NOT NULL,
	"telegram_chat_id" text,
	"experiment_group" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_stats" (
	"creator" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"launches" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"rugs" integer DEFAULT 0 NOT NULL,
	"last_launch_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_stats_creator_network_pk" PRIMARY KEY("creator","network")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arm_id" uuid,
	"token" text,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text,
	"entry_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equity_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arm_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"realized_wei" numeric(40, 0) NOT NULL,
	"open_value_wei" numeric(40, 0) NOT NULL,
	"equity_wei" numeric(40, 0) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firewall_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"venue" text NOT NULL,
	"verdict" text NOT NULL,
	"score" real NOT NULL,
	"round_trip_loss_pct" real,
	"checks" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_features" (
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_seconds" integer DEFAULT 90 NOT NULL,
	"features" jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "launch_features_token_network_pk" PRIMARY KEY("token","network")
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"launchpad" text NOT NULL,
	"creator" text NOT NULL,
	"pool" text,
	"venue" text NOT NULL,
	"block_number" numeric(20, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feed_lead_ms" integer,
	"name" text,
	"symbol" text,
	"decimals" integer DEFAULT 18 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graduated_at" timestamp with time zone,
	CONSTRAINT "launches_token_network_pk" PRIMARY KEY("token","network")
);
--> statement-breakpoint
CREATE TABLE "oracle_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"reason" text,
	"training_rows" integer NOT NULL,
	"fitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" jsonb NOT NULL,
	"holdout" jsonb,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oracle_outcomes" (
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"label_version" integer DEFAULT 1 NOT NULL,
	"win" boolean NOT NULL,
	"rug" boolean NOT NULL,
	"moon" boolean NOT NULL,
	"ath_multiple" real,
	"realized_win" boolean,
	"realized_pnl_pct" real,
	"realized_samples" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oracle_outcomes_token_network_pk" PRIMARY KEY("token","network")
);
--> statement-breakpoint
CREATE TABLE "oracle_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_version" text NOT NULL,
	"score" real NOT NULL,
	"tier" text NOT NULL,
	"rug_risk" real NOT NULL,
	"probabilities" jsonb NOT NULL,
	"pillars" jsonb NOT NULL,
	"hits" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"confidence" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arm_id" uuid NOT NULL,
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"launchpad" text NOT NULL,
	"venue" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"entry_wei" numeric(40, 0) NOT NULL,
	"token_amount" numeric(40, 0) NOT NULL,
	"token_decimals" integer DEFAULT 18 NOT NULL,
	"buy_tx" text NOT NULL,
	"sell_tx" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"peak_value_wei" numeric(40, 0) DEFAULT '0' NOT NULL,
	"last_value_wei" numeric(40, 0),
	"stale_since" timestamp with time zone,
	"initials_recovered" boolean DEFAULT false NOT NULL,
	"realized_pnl_wei" numeric(40, 0),
	"realized_pnl_pct" real,
	"exit_reason" text,
	"oracle_score_at_entry" real,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arm_id" uuid NOT NULL,
	"position_id" uuid,
	"token" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"side" text NOT NULL,
	"mode" text NOT NULL,
	"venue" text NOT NULL,
	"amount_in" numeric(40, 0) NOT NULL,
	"amount_out" numeric(40, 0) NOT NULL,
	"tx_hash" text NOT NULL,
	"gas_wei" numeric(40, 0),
	"price_impact_pct" real,
	"slippage_bps" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_arm_id_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."arms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equity_points" ADD CONSTRAINT "equity_points_arm_id_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."arms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_arm_id_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."arms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_arm_id_arms_id_fk" FOREIGN KEY ("arm_id") REFERENCES "public"."arms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_at_idx" ON "decisions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "decisions_token_idx" ON "decisions" USING btree ("token","at");--> statement-breakpoint
CREATE INDEX "equity_arm_at_idx" ON "equity_points" USING btree ("arm_id","at");--> statement-breakpoint
CREATE INDEX "firewall_token_idx" ON "firewall_decisions" USING btree ("network","token","at");--> statement-breakpoint
CREATE INDEX "launches_first_seen_idx" ON "launches" USING btree ("network","first_seen_at");--> statement-breakpoint
CREATE INDEX "launches_creator_idx" ON "launches" USING btree ("network","creator");--> statement-breakpoint
CREATE INDEX "oracle_models_status_idx" ON "oracle_models" USING btree ("network","status","fitted_at");--> statement-breakpoint
CREATE INDEX "oracle_scores_token_idx" ON "oracle_scores" USING btree ("network","token","scored_at");--> statement-breakpoint
CREATE INDEX "oracle_scores_at_idx" ON "oracle_scores" USING btree ("network","scored_at");--> statement-breakpoint
CREATE INDEX "positions_open_idx" ON "positions" USING btree ("network","status");--> statement-breakpoint
CREATE INDEX "positions_arm_idx" ON "positions" USING btree ("arm_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_arm_token_open_uidx" ON "positions" USING btree ("arm_id","token") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "trades_arm_at_idx" ON "trades" USING btree ("arm_id","at");--> statement-breakpoint
CREATE INDEX "trades_at_idx" ON "trades" USING btree ("network","at");