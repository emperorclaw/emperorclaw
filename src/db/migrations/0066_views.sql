CREATE TABLE "view_panel_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"panel_id" text NOT NULL,
	"data_json" jsonb NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "view_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"spec_json" jsonb NOT NULL,
	"author_type" text NOT NULL,
	"author_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"scope_type" text DEFAULT 'company' NOT NULL,
	"scope_id" uuid,
	"spec_json" jsonb DEFAULT '{"panels":[]}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid,
	"updated_by_type" text NOT NULL,
	"updated_by_id" uuid,
	"pinned_to_home" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "views_scope_type_check" CHECK ("views"."scope_type" IN ('company', 'customer', 'project'))
);
--> statement-breakpoint
ALTER TABLE "view_panel_data" ADD CONSTRAINT "view_panel_data_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_panel_data" ADD CONSTRAINT "view_panel_data_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_versions" ADD CONSTRAINT "view_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_versions" ADD CONSTRAINT "view_versions_view_id_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "view_panel_data_view_panel_unique" ON "view_panel_data" USING btree ("view_id","panel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "view_versions_view_version_unique" ON "view_versions" USING btree ("view_id","version");--> statement-breakpoint
CREATE INDEX "views_company_updated_idx" ON "views" USING btree ("company_id","updated_at" DESC NULLS LAST);