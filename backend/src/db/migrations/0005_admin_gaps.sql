CREATE TABLE "gomax"."content_pages" (
	"key" varchar(30) PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gomax"."dealers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_id" varchar(24) NOT NULL,
	"firm" text NOT NULL,
	"owner_name" text NOT NULL,
	"mobile" varchar(10) NOT NULL,
	"gst" varchar(15),
	"area" varchar(10) NOT NULL,
	"area_team" text,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"temp_password_expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_reason" text,
	"last_login_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealers_login_id_unique" UNIQUE("login_id")
);
--> statement-breakpoint
CREATE TABLE "gomax"."home_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"art" varchar(40) DEFAULT 'sparkles' NOT NULL,
	"rule" varchar(16) DEFAULT 'always' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"link" varchar(60),
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gomax"."coupon_batches" ADD COLUMN "area" varchar(40);--> statement-breakpoint
CREATE INDEX "dealers_area_idx" ON "gomax"."dealers" USING btree ("area");--> statement-breakpoint
-- New tables get the same lockdown as the rest (0002): RLS on, no policies.
ALTER TABLE "gomax"."dealers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gomax"."home_cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gomax"."content_pages" ENABLE ROW LEVEL SECURITY;
