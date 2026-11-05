ALTER TABLE "gomax"."users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gomax"."users" ADD COLUMN "firebase_uid" text;