ALTER TABLE "app_private"."player_decisions" DROP CONSTRAINT "player_decisions_status_check";--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" DROP CONSTRAINT "player_decisions_stage_matrix_check";--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" DROP CONSTRAINT "player_decisions_timestamp_order_check";--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD COLUMN "command_ledger_id" uuid;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_command_ledger_scope_fk" FOREIGN KEY ("command_ledger_id","session_id","owner_id") REFERENCES "app_private"."command_ledger"("id","session_id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_command_ledger_unique" UNIQUE("command_ledger_id");--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_status_check" CHECK ("app_private"."player_decisions"."status" IN ('auditPrepared', 'modelPrepared', 'selected', 'committed'));--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_stage_matrix_check" CHECK ((
        "app_private"."player_decisions"."status" = 'auditPrepared'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NULL
        AND "app_private"."player_decisions"."selected_at" IS NULL
        AND "app_private"."player_decisions"."command_ledger_id" IS NULL
        AND "app_private"."player_decisions"."committed_at" IS NULL
      ) OR (
        "app_private"."player_decisions"."status" = 'modelPrepared'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NOT NULL
        AND "app_private"."player_decisions"."selected_at" IS NULL
        AND "app_private"."player_decisions"."command_ledger_id" IS NULL
        AND "app_private"."player_decisions"."committed_at" IS NULL
      ) OR (
        "app_private"."player_decisions"."status" = 'selected'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NOT NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NOT NULL
        AND "app_private"."player_decisions"."selected_at" IS NOT NULL
        AND "app_private"."player_decisions"."command_ledger_id" IS NULL
        AND "app_private"."player_decisions"."committed_at" IS NULL
      ) OR (
        "app_private"."player_decisions"."status" = 'committed'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NOT NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NOT NULL
        AND "app_private"."player_decisions"."selected_at" IS NOT NULL
        AND "app_private"."player_decisions"."command_ledger_id" IS NOT NULL
        AND "app_private"."player_decisions"."committed_at" IS NOT NULL
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
        ));