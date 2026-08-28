ALTER TABLE "app_private"."player_decisions" DROP CONSTRAINT "player_decisions_timestamp_order_check";--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD COLUMN "terminal_outcome" text;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD COLUMN "terminal_reason" text;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD COLUMN "terminated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_parent_run_unique" ON "app_private"."agent_runs" USING btree ("parent_run_id") WHERE "app_private"."agent_runs"."parent_run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_replacement_run_unique" ON "app_private"."agent_runs" USING btree ("replacement_run_id") WHERE "app_private"."agent_runs"."replacement_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs" ADD CONSTRAINT "agent_runs_replacement_not_self_check" CHECK (("app_private"."agent_runs"."parent_run_id" IS NULL OR "app_private"."agent_runs"."parent_run_id" <> "app_private"."agent_runs"."id")
        AND ("app_private"."agent_runs"."replacement_run_id" IS NULL OR "app_private"."agent_runs"."replacement_run_id" <> "app_private"."agent_runs"."id"));--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_terminal_outcome_check" CHECK ((
        "app_private"."player_decisions"."terminal_outcome" IS NULL
        AND "app_private"."player_decisions"."terminal_reason" IS NULL
        AND "app_private"."player_decisions"."terminated_at" IS NULL
      ) OR (
        "app_private"."player_decisions"."terminal_outcome" IN ('failed', 'stale')
        AND "app_private"."player_decisions"."terminal_reason" IS NOT NULL
        AND length(btrim("app_private"."player_decisions"."terminal_reason")) > 0
        AND "app_private"."player_decisions"."terminated_at" IS NOT NULL
        AND "app_private"."player_decisions"."status" <> 'committed'
      ));--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_timestamp_order_check" CHECK (("app_private"."player_decisions"."model_prepared_at" IS NULL OR "app_private"."player_decisions"."model_prepared_at" >= "app_private"."player_decisions"."created_at")
        AND ("app_private"."player_decisions"."selected_at" IS NULL OR "app_private"."player_decisions"."selected_at" >= "app_private"."player_decisions"."created_at")
        AND (
          "app_private"."player_decisions"."model_prepared_at" IS NULL
          OR "app_private"."player_decisions"."selected_at" IS NULL
          OR "app_private"."player_decisions"."selected_at" >= "app_private"."player_decisions"."model_prepared_at"
        )
        AND (
          "app_private"."player_decisions"."committed_at" IS NULL
          OR ("app_private"."player_decisions"."selected_at" IS NOT NULL AND "app_private"."player_decisions"."committed_at" >= "app_private"."player_decisions"."selected_at")
        )
        AND ("app_private"."player_decisions"."terminated_at" IS NULL OR "app_private"."player_decisions"."terminated_at" >= "app_private"."player_decisions"."created_at"));