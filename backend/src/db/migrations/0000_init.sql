CREATE SCHEMA "gomax";
--> statement-breakpoint
CREATE TYPE "gomax"."batch_status" AS ENUM('generated', 'printed', 'in_market', 'blocked');--> statement-breakpoint
CREATE TYPE "gomax"."card_status" AS ENUM('new', 'revealed', 'expired');--> statement-breakpoint
CREATE TYPE "gomax"."challenge_kind" AS ENUM('scan_count', 'ultra_scan_count', 'invite_count', 'streak_days');--> statement-breakpoint
CREATE TYPE "gomax"."challenge_period" AS ENUM('week', 'range');--> statement-breakpoint
CREATE TYPE "gomax"."flag_status" AS ENUM('open', 'cleared', 'confirmed');--> statement-breakpoint
CREATE TYPE "gomax"."ledger_kind" AS ENUM('scan', 'bonus', 'withdraw', 'withdraw_refund', 'spin', 'scratch', 'challenge', 'quest', 'streak', 'invite', 'referral', 'gift', 'gift_refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "gomax"."note_kind" AS ENUM('money', 'gifts', 'games', 'invite');--> statement-breakpoint
CREATE TYPE "gomax"."order_step" AS ENUM('booked', 'packed', 'shipped', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "gomax"."outbox_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "gomax"."review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "gomax"."scan_result" AS ENUM('added', 'already_used', 'expired', 'not_active', 'wrong_code', 'blocked');--> statement-breakpoint
CREATE TYPE "gomax"."scan_source" AS ENUM('scan', 'typed', 'offline');--> statement-breakpoint
CREATE TYPE "gomax"."staff_role" AS ENUM('owner', 'accounts', 'factory', 'helpline', 'ops');--> statement-breakpoint
CREATE TYPE "gomax"."user_status" AS ENUM('active', 'blocked');--> statement-breakpoint
CREATE TYPE "gomax"."wallet" AS ENUM('points', 'runs');--> statement-breakpoint
CREATE TYPE "gomax"."withdrawal_status" AS ENUM('requested', 'approved', 'paid', 'rejected', 'failed', 'held');--> statement-breakpoint
CREATE TABLE "gomax"."audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" varchar(10) NOT NULL,
	"actor_id" uuid,
	"action" varchar(60) NOT NULL,
	"entity" varchar(40) NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."challenge_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"challenge_id" varchar(40) NOT NULL,
	"user_id" uuid NOT NULL,
	"period_key" varchar(20) NOT NULL,
	"runs" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."challenges" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"kind" "gomax"."challenge_kind" NOT NULL,
	"period" "gomax"."challenge_period" NOT NULL,
	"tag" text NOT NULL,
	"tone" varchar(10) DEFAULT 'runs' NOT NULL,
	"title" text NOT NULL,
	"short_title" text NOT NULL,
	"goal" integer NOT NULL,
	"reward_runs" integer NOT NULL,
	"reward_scratch_cards" integer DEFAULT 0 NOT NULL,
	"bonus_text" text,
	"art" varchar(40) DEFAULT 'bullseye' NOT NULL,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."coupon_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" varchar(12) NOT NULL,
	"value_points" integer NOT NULL,
	"line" varchar(20) DEFAULT 'standard' NOT NULL,
	"quantity" integer NOT NULL,
	"status" "gomax"."batch_status" DEFAULT 'generated' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"note" text,
	"blocked_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"printed_at" timestamp with time zone,
	"in_market_at" timestamp with time zone,
	CONSTRAINT "coupon_batches_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "gomax"."coupons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" varchar(8) NOT NULL,
	"batch_id" integer NOT NULL,
	"serial" integer NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"scanned_by" uuid,
	"scanned_at" timestamp with time zone,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "gomax"."fraud_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"rule" varchar(30) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "gomax"."flag_status" DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."gift_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"gift_id" varchar(40) NOT NULL,
	"size" text,
	"runs" integer NOT NULL,
	"address" jsonb NOT NULL,
	"step" "gomax"."order_step" DEFAULT 'booked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"packed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"courier_name" text,
	"awb" text,
	"tracking_url" text,
	"eta" date,
	"delivery_photo_object" text,
	"received_by" text
);
--> statement-breakpoint
CREATE TABLE "gomax"."gifts" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"runs_price" integer NOT NULL,
	"stock" integer,
	"active" boolean DEFAULT true NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"market_value_inr" integer,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."helpline_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"mobile" varchar(10) NOT NULL,
	"user_id" uuid,
	"status" varchar(10) DEFAULT 'open' NOT NULL,
	"handled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet" "gomax"."wallet" NOT NULL,
	"kind" "gomax"."ledger_kind" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"title" text NOT NULL,
	"sub" text,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_amount_nonzero" CHECK ("gomax"."ledger"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "gomax"."notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "gomax"."note_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"art" varchar(40),
	"link" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "gomax"."products" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" varchar(30) NOT NULL,
	"data" jsonb NOT NULL,
	"tds_object" text,
	"tds_bytes" integer,
	"tds_updated_at" timestamp with time zone,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."quest_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"quest" varchar(20) NOT NULL,
	"runs" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."referral_credits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"earner_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"scan_id" bigint,
	"runs" integer NOT NULL,
	"month_key" varchar(7) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(5) NOT NULL,
	"subject_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "gomax"."scans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_raw" text NOT NULL,
	"code" varchar(16),
	"coupon_id" bigint,
	"result" "gomax"."scan_result" NOT NULL,
	"source" "gomax"."scan_source" NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"accuracy" real,
	"device_id" text,
	"device_model" text,
	"app_version" text,
	"scanned_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."scratch_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"earned_day" date NOT NULL,
	"status" "gomax"."card_status" DEFAULT 'new' NOT NULL,
	"prize_kind" "gomax"."wallet" NOT NULL,
	"prize_amount" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revealed_at" timestamp with time zone,
	"source" varchar(60) DEFAULT 'coupons' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."settings" (
	"key" varchar(60) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."spins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"prize_runs" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_id" varchar(40) NOT NULL,
	"name" text NOT NULL,
	"role" "gomax"."staff_role" NOT NULL,
	"mobile" varchar(10),
	"password_hash" text NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_login_id_unique" UNIQUE("login_id")
);
--> statement-breakpoint
CREATE TABLE "gomax"."streak_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"object" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"taken_at" timestamp with time zone NOT NULL,
	"status" "gomax"."review_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."streak_rewards" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"milestone" integer NOT NULL,
	"run_start" date NOT NULL,
	"runs" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."user_kyc" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"pan_enc" text,
	"pan_masked" varchar(10),
	"pan_name" text,
	"pan_verified_at" timestamp with time zone,
	"upi_id" text,
	"upi_name" text,
	"upi_matches_pan" boolean,
	"upi_verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"city" text,
	"birthday" date,
	"anniversary" date,
	"language" varchar(2) DEFAULT 'hi' NOT NULL,
	"invite_code" varchar(12) NOT NULL,
	"referred_by" uuid,
	"status" "gomax"."user_status" DEFAULT 'active' NOT NULL,
	"cash_hold" boolean DEFAULT false NOT NULL,
	"whatsapp_opt_in" boolean DEFAULT true NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"lifetime_points" integer DEFAULT 0 NOT NULL,
	"first_coupon_at" timestamp with time zone,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_mobile_unique" UNIQUE("mobile"),
	CONSTRAINT "users_invite_code_unique" UNIQUE("invite_code"),
	CONSTRAINT "users_points_nonneg" CHECK ("gomax"."users"."points" >= 0),
	CONSTRAINT "users_runs_nonneg" CHECK ("gomax"."users"."runs" >= 0)
);
--> statement-breakpoint
CREATE TABLE "gomax"."wa_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"to_mobile" varchar(10) NOT NULL,
	"template" varchar(60) NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "gomax"."outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"upi_id" text NOT NULL,
	"upi_name" text,
	"upi_qr_object" text,
	"status" "gomax"."withdrawal_status" DEFAULT 'requested' NOT NULL,
	"reason" text,
	"name_differs" boolean DEFAULT false NOT NULL,
	"month_key" varchar(7) NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"locked_by" uuid,
	"locked_until" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"utr" varchar(12),
	"proof_object" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_utr_unique" UNIQUE("utr"),
	CONSTRAINT "withdrawals_amount_pos" CHECK ("gomax"."withdrawals"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "gomax"."coupons" ADD CONSTRAINT "coupons_batch_id_coupon_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "gomax"."coupon_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gomax"."gift_orders" ADD CONSTRAINT "gift_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "gomax"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gomax"."gift_orders" ADD CONSTRAINT "gift_orders_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "gomax"."gifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gomax"."ledger" ADD CONSTRAINT "ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "gomax"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gomax"."password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "gomax"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gomax"."user_kyc" ADD CONSTRAINT "user_kyc_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "gomax"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "gomax"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "gomax"."audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_time_idx" ON "gomax"."audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_claims_uq" ON "gomax"."challenge_claims" USING btree ("challenge_id","user_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_batch_serial_uq" ON "gomax"."coupons" USING btree ("batch_id","serial");--> statement-breakpoint
CREATE INDEX "coupons_scanned_by_idx" ON "gomax"."coupons" USING btree ("scanned_by");--> statement-breakpoint
CREATE INDEX "fraud_flags_status_idx" ON "gomax"."fraud_flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "fraud_flags_user_idx" ON "gomax"."fraud_flags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gift_orders_user_idx" ON "gomax"."gift_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gift_orders_step_idx" ON "gomax"."gift_orders" USING btree ("step","created_at");--> statement-breakpoint
CREATE INDEX "ledger_user_wallet_time_idx" ON "gomax"."ledger" USING btree ("user_id","wallet","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "gomax"."notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quest_claims_uq" ON "gomax"."quest_claims" USING btree ("user_id","day","quest");--> statement-breakpoint
CREATE INDEX "referral_earner_month_idx" ON "gomax"."referral_credits" USING btree ("earner_id","month_key");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_bonus_uq" ON "gomax"."referral_credits" USING btree ("earner_id","from_user_id","level","scan_id");--> statement-breakpoint
CREATE INDEX "refresh_subject_idx" ON "gomax"."refresh_tokens" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "scans_user_time_idx" ON "gomax"."scans" USING btree ("user_id","scanned_at");--> statement-breakpoint
CREATE INDEX "scans_coupon_idx" ON "gomax"."scans" USING btree ("coupon_id");--> statement-breakpoint
CREATE INDEX "scans_code_idx" ON "gomax"."scans" USING btree ("code");--> statement-breakpoint
CREATE INDEX "scans_user_day_idx" ON "gomax"."scans" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "scratch_user_day_src_uq" ON "gomax"."scratch_cards" USING btree ("user_id","earned_day","source");--> statement-breakpoint
CREATE INDEX "scratch_user_idx" ON "gomax"."scratch_cards" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "spins_user_day_idx" ON "gomax"."spins" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "streak_user_day_uq" ON "gomax"."streak_photos" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "streak_status_idx" ON "gomax"."streak_photos" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "streak_rewards_uq" ON "gomax"."streak_rewards" USING btree ("user_id","milestone","run_start");--> statement-breakpoint
CREATE INDEX "users_referred_by_idx" ON "gomax"."users" USING btree ("referred_by");--> statement-breakpoint
CREATE INDEX "users_device_idx" ON "gomax"."users" USING btree ("last_device_id");--> statement-breakpoint
CREATE INDEX "wa_outbox_pending_idx" ON "gomax"."wa_outbox" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "withdrawals_status_idx" ON "gomax"."withdrawals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "withdrawals_user_idx" ON "gomax"."withdrawals" USING btree ("user_id","month_key");