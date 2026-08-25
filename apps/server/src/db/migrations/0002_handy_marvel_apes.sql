CREATE TABLE "app_private"."player_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"hand_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"source_state_version" bigint NOT NULL,
	"decision_request_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"record_version" integer NOT NULL,
	"status" text NOT NULL,
	"decision_audit_snapshot_payload_version" integer NOT NULL,
	"decision_audit_snapshot_payload" jsonb NOT NULL,
	"candidate_set_payload_version" integer NOT NULL,
	"candidate_set_payload" jsonb NOT NULL,
	"model_projection_payload_version" integer,
	"model_projection_payload" jsonb,
	"model_choice_payload_version" integer,
	"model_choice_payload" jsonb,
	"validator_result_payload_version" integer,
	"validator_result_payload" jsonb,
	"accepted_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_prepared_at" timestamp with time zone,
	"selected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_decisions_agent_run_unique" UNIQUE("agent_run_id"),
	CONSTRAINT "player_decisions_identity_check" CHECK ("app_private"."player_decisions"."runtime" = 'player'
        AND "app_private"."player_decisions"."record_version" = 1
        AND "app_private"."player_decisions"."source_state_version" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "player_decisions_status_check" CHECK ("app_private"."player_decisions"."status" IN ('auditPrepared', 'modelPrepared', 'selected')),
	CONSTRAINT "player_decisions_required_payloads_check" CHECK ("app_private"."player_decisions"."decision_audit_snapshot_payload_version" > 0
        AND jsonb_typeof("app_private"."player_decisions"."decision_audit_snapshot_payload") = 'object'
        AND "app_private"."player_decisions"."candidate_set_payload_version" > 0
        AND jsonb_typeof("app_private"."player_decisions"."candidate_set_payload") = 'object'),
	CONSTRAINT "player_decisions_optional_payload_pairs_check" CHECK (((
        "app_private"."player_decisions"."model_projection_payload_version" IS NULL
        AND "app_private"."player_decisions"."model_projection_payload" IS NULL
      ) OR (
        "app_private"."player_decisions"."model_projection_payload_version" > 0
        AND jsonb_typeof("app_private"."player_decisions"."model_projection_payload") = 'object'
      ))
        AND (
          (
          "app_private"."player_decisions"."model_choice_payload_version" IS NULL
          AND "app_private"."player_decisions"."model_choice_payload" IS NULL
          ) OR (
          "app_private"."player_decisions"."model_choice_payload_version" > 0
          AND jsonb_typeof("app_private"."player_decisions"."model_choice_payload") = 'object'
          )
        )
        AND (
          (
          "app_private"."player_decisions"."validator_result_payload_version" IS NULL
          AND "app_private"."player_decisions"."validator_result_payload" IS NULL
          ) OR (
          "app_private"."player_decisions"."validator_result_payload_version" > 0
          AND jsonb_typeof("app_private"."player_decisions"."validator_result_payload") = 'object'
          )
        )),
	CONSTRAINT "player_decisions_stage_matrix_check" CHECK ((
        "app_private"."player_decisions"."status" = 'auditPrepared'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NULL
        AND "app_private"."player_decisions"."selected_at" IS NULL
      ) OR (
        "app_private"."player_decisions"."status" = 'modelPrepared'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NOT NULL
        AND "app_private"."player_decisions"."selected_at" IS NULL
      ) OR (
        "app_private"."player_decisions"."status" = 'selected'
        AND "app_private"."player_decisions"."model_projection_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."model_choice_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."validator_result_payload_version" IS NOT NULL
        AND "app_private"."player_decisions"."accepted_attempt_id" IS NOT NULL
        AND "app_private"."player_decisions"."model_prepared_at" IS NOT NULL
        AND "app_private"."player_decisions"."selected_at" IS NOT NULL
      )),
	CONSTRAINT "player_decisions_timestamp_order_check" CHECK (("app_private"."player_decisions"."model_prepared_at" IS NULL OR "app_private"."player_decisions"."model_prepared_at" >= "app_private"."player_decisions"."created_at")
        AND ("app_private"."player_decisions"."selected_at" IS NULL OR "app_private"."player_decisions"."selected_at" >= "app_private"."player_decisions"."created_at")
        AND (
          "app_private"."player_decisions"."model_prepared_at" IS NULL
          OR "app_private"."player_decisions"."selected_at" IS NULL
          OR "app_private"."player_decisions"."selected_at" >= "app_private"."player_decisions"."model_prepared_at"
        ))
);
--> statement-breakpoint
ALTER TABLE "app_private"."agent_attempts" ADD CONSTRAINT "agent_attempts_id_run_owner_session_unique" UNIQUE("id","agent_run_id","owner_id","session_id");--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs" ADD CONSTRAINT "agent_runs_player_decision_identity_unique" UNIQUE("id","owner_id","session_id","hand_id","participant_id","source_state_version","decision_request_id","runtime");--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_run_identity_fk" FOREIGN KEY ("agent_run_id","owner_id","session_id","hand_id","participant_id","source_state_version","decision_request_id","runtime") REFERENCES "app_private"."agent_runs"("id","owner_id","session_id","hand_id","participant_id","source_state_version","decision_request_id","runtime") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_participant_scope_fk" FOREIGN KEY ("participant_id","session_id","owner_id") REFERENCES "app_private"."session_agents"("participant_id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_accepted_attempt_scope_fk" FOREIGN KEY ("accepted_attempt_id","agent_run_id","owner_id","session_id") REFERENCES "app_private"."agent_attempts"("id","agent_run_id","owner_id","session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_decisions_session_status_idx" ON "app_private"."player_decisions" USING btree ("session_id","status","updated_at");
