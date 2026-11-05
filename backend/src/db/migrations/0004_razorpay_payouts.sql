ALTER TABLE "gomax"."user_kyc" ADD COLUMN "rzp_contact_id" text;--> statement-breakpoint
ALTER TABLE "gomax"."user_kyc" ADD COLUMN "rzp_fund_account_id" text;--> statement-breakpoint
ALTER TABLE "gomax"."user_kyc" ADD COLUMN "rzp_fund_account_vpa" text;--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD COLUMN "payout_mode" varchar(12);--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD COLUMN "payout_ref" text;--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD COLUMN "payout_status" varchar(20);--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD COLUMN "payout_error" text;--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD COLUMN "payout_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gomax"."withdrawals" ADD CONSTRAINT "withdrawals_payout_ref_unique" UNIQUE("payout_ref");