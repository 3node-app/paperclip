ALTER TABLE "project_workspaces" ADD COLUMN IF NOT EXISTS "materialization_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN IF NOT EXISTS "materialization_error" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN IF NOT EXISTS "materialized_at" timestamp with time zone;--> statement-breakpoint
UPDATE "project_workspaces" SET "materialization_status" = 'not_applicable' WHERE "source_type" != 'git_repo' OR "repo_url" IS NULL;
