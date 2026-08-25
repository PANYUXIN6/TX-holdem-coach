ALTER TABLE "app_private"."player_decisions" DROP CONSTRAINT "player_decisions_optional_payload_pairs_check";--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_optional_payload_pairs_check" CHECK (((
        "app_private"."player_decisions"."model_projection_payload_version" IS NULL
        AND "app_private"."player_decisions"."model_projection_payload" IS NULL
      ) OR (
        "app_private"."player_decisions"."model_projection_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."model_projection_payload_version" > 0
        AND "app_private"."player_decisions"."model_projection_payload" IS NOT NULL
        AND jsonb_typeof("app_private"."player_decisions"."model_projection_payload") = 'object'
      ))
        AND (
          (
          "app_private"."player_decisions"."model_choice_payload_version" IS NULL
          AND "app_private"."player_decisions"."model_choice_payload" IS NULL
          ) OR (
          "app_private"."player_decisions"."model_choice_payload_version" IS NOT NULL
          AND "app_private"."player_decisions"."model_choice_payload_version" > 0
          AND "app_private"."player_decisions"."model_choice_payload" IS NOT NULL
          AND jsonb_typeof("app_private"."player_decisions"."model_choice_payload") = 'object'
          )
        )
        AND (
          (
          "app_private"."player_decisions"."validator_result_payload_version" IS NULL
          AND "app_private"."player_decisions"."validator_result_payload" IS NULL
          ) OR (
          "app_private"."player_decisions"."validator_result_payload_version" IS NOT NULL
          AND "app_private"."player_decisions"."validator_result_payload_version" > 0
          AND "app_private"."player_decisions"."validator_result_payload" IS NOT NULL
          AND jsonb_typeof("app_private"."player_decisions"."validator_result_payload") = 'object'
          )
        ));