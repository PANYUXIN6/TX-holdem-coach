CREATE SCHEMA IF NOT EXISTS "app_private";
--> statement-breakpoint
CREATE TABLE "app_private"."agent_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"fencing_token" bigint NOT NULL,
	"stage" text NOT NULL,
	"lifecycle" text NOT NULL,
	"accepted" boolean DEFAULT false NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt_type" text NOT NULL,
	"routing_reason" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_microunits" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint,
	"error_category" text,
	"attempt_payload_version" integer,
	"attempt_payload" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_attempts_run_number_unique" UNIQUE("agent_run_id","attempt_number"),
	CONSTRAINT "agent_attempts_attempt_number_check" CHECK ("app_private"."agent_attempts"."attempt_number" >= 0
        AND "app_private"."agent_attempts"."fencing_token" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "agent_attempts_lifecycle_check" CHECK ("app_private"."agent_attempts"."lifecycle" IN ('started', 'completed', 'failed', 'cancelled', 'stale')),
	CONSTRAINT "agent_attempts_safe_values_check" CHECK ("app_private"."agent_attempts"."input_tokens" BETWEEN 0 AND 9007199254740991
        AND "app_private"."agent_attempts"."output_tokens" BETWEEN 0 AND 9007199254740991
        AND "app_private"."agent_attempts"."cost_microunits" BETWEEN 0 AND 9007199254740991
        AND (
          "app_private"."agent_attempts"."duration_ms" IS NULL
          OR "app_private"."agent_attempts"."duration_ms" BETWEEN 0 AND 9007199254740991
        )),
	CONSTRAINT "agent_attempts_payload_check" CHECK ((
        "app_private"."agent_attempts"."attempt_payload_version" IS NULL
        AND "app_private"."agent_attempts"."attempt_payload" IS NULL
      ) OR (
        "app_private"."agent_attempts"."attempt_payload_version" IS NOT NULL
        AND "app_private"."agent_attempts"."attempt_payload" IS NOT NULL
        AND "app_private"."agent_attempts"."attempt_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_attempts"."attempt_payload") = 'object'
      ))
);
--> statement-breakpoint
CREATE TABLE "app_private"."agent_capability_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"invocation_number" integer NOT NULL,
	"fencing_token" bigint NOT NULL,
	"capability_name" text NOT NULL,
	"capability_version" integer NOT NULL,
	"authorized" boolean NOT NULL,
	"input_schema_version" integer NOT NULL,
	"input_hash" text NOT NULL,
	"output_schema_version" integer,
	"output_hash" text,
	"budget_cost" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint,
	"error_category" text,
	"invocation_payload_version" integer,
	"invocation_payload" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_capability_invocations_run_number_unique" UNIQUE("agent_run_id","invocation_number"),
	CONSTRAINT "agent_capability_invocations_number_check" CHECK ("app_private"."agent_capability_invocations"."invocation_number" >= 0
        AND "app_private"."agent_capability_invocations"."fencing_token" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "agent_capability_invocations_schema_versions_check" CHECK ("app_private"."agent_capability_invocations"."capability_version" > 0
        AND "app_private"."agent_capability_invocations"."input_schema_version" > 0
        AND (
          (
            "app_private"."agent_capability_invocations"."output_schema_version" IS NULL
            AND "app_private"."agent_capability_invocations"."output_hash" IS NULL
          ) OR (
            "app_private"."agent_capability_invocations"."output_schema_version" IS NOT NULL
            AND "app_private"."agent_capability_invocations"."output_hash" IS NOT NULL
            AND "app_private"."agent_capability_invocations"."output_schema_version" > 0
            AND "app_private"."agent_capability_invocations"."output_hash" ~ '^[0-9a-f]{64}$'
          )
        )),
	CONSTRAINT "agent_capability_invocations_input_hash_check" CHECK ("app_private"."agent_capability_invocations"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_capability_invocations_safe_values_check" CHECK ("app_private"."agent_capability_invocations"."budget_cost" BETWEEN 0 AND 9007199254740991
        AND (
          "app_private"."agent_capability_invocations"."duration_ms" IS NULL
          OR "app_private"."agent_capability_invocations"."duration_ms" BETWEEN 0 AND 9007199254740991
        )),
	CONSTRAINT "agent_capability_invocations_payload_check" CHECK ((
        "app_private"."agent_capability_invocations"."invocation_payload_version" IS NULL
        AND "app_private"."agent_capability_invocations"."invocation_payload" IS NULL
      ) OR (
        "app_private"."agent_capability_invocations"."invocation_payload_version" IS NOT NULL
        AND "app_private"."agent_capability_invocations"."invocation_payload" IS NOT NULL
        AND "app_private"."agent_capability_invocations"."invocation_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_capability_invocations"."invocation_payload") = 'object'
      ))
);
--> statement-breakpoint
CREATE TABLE "app_private"."agent_memory_revisions" (
	"participant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"memory_payload_version" integer NOT NULL,
	"memory_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_revisions_pk" PRIMARY KEY("participant_id","revision"),
	CONSTRAINT "agent_memory_revisions_scope_revision_unique" UNIQUE("participant_id","session_id","owner_id","revision"),
	CONSTRAINT "agent_memory_revisions_revision_safe" CHECK ("app_private"."agent_memory_revisions"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "agent_memory_revisions_payload_check" CHECK ("app_private"."agent_memory_revisions"."memory_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_memory_revisions"."memory_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_private"."agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"runtime" text NOT NULL,
	"trigger_type" text NOT NULL,
	"lifecycle" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"hand_id" uuid NOT NULL,
	"participant_id" uuid,
	"source_state_version" bigint,
	"decision_request_id" uuid,
	"parent_run_id" uuid,
	"replacement_run_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"runtime_definition_version" integer NOT NULL,
	"termination_reason" text,
	"run_config_payload_version" integer NOT NULL,
	"run_config_payload" jsonb NOT NULL,
	"budget_payload_version" integer NOT NULL,
	"budget_payload" jsonb NOT NULL,
	"checkpoint_payload_version" integer,
	"checkpoint_payload" jsonb,
	"result_payload_version" integer,
	"result_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_session_runtime_idempotency_unique" UNIQUE("session_id","runtime","idempotency_key"),
	CONSTRAINT "agent_runs_session_request_unique" UNIQUE("session_id","decision_request_id"),
	CONSTRAINT "agent_runs_id_session_owner_request_unique" UNIQUE("id","session_id","owner_id","decision_request_id"),
	CONSTRAINT "agent_runs_player_decision_identity_unique" UNIQUE("id","owner_id","session_id","hand_id","participant_id","source_state_version","decision_request_id","runtime"),
	CONSTRAINT "agent_runs_id_owner_session_unique" UNIQUE("id","owner_id","session_id"),
	CONSTRAINT "agent_runs_runtime_check" CHECK ("app_private"."agent_runs"."runtime" IN ('player', 'coach')),
	CONSTRAINT "agent_runs_lifecycle_check" CHECK ("app_private"."agent_runs"."lifecycle" IN (
        'queued', 'leased', 'running', 'completed', 'failed', 'cancelled', 'stale'
      )),
	CONSTRAINT "agent_runs_idempotency_key_not_blank" CHECK (length(btrim("app_private"."agent_runs"."idempotency_key")) > 0),
	CONSTRAINT "agent_runs_runtime_fields_check" CHECK ((
        "app_private"."agent_runs"."runtime" = 'player'
        AND "app_private"."agent_runs"."participant_id" IS NOT NULL
        AND "app_private"."agent_runs"."source_state_version" IS NOT NULL
        AND "app_private"."agent_runs"."decision_request_id" IS NOT NULL
      ) OR (
        "app_private"."agent_runs"."runtime" = 'coach'
        AND "app_private"."agent_runs"."participant_id" IS NULL
        AND "app_private"."agent_runs"."source_state_version" IS NULL
        AND "app_private"."agent_runs"."decision_request_id" IS NULL
      )),
	CONSTRAINT "agent_runs_safe_values_check" CHECK ("app_private"."agent_runs"."fencing_token" BETWEEN 0 AND 9007199254740991
        AND (
          "app_private"."agent_runs"."source_state_version" IS NULL
          OR "app_private"."agent_runs"."source_state_version" BETWEEN 0 AND 9007199254740991
        )),
	CONSTRAINT "agent_runs_runtime_definition_version_positive" CHECK ("app_private"."agent_runs"."runtime_definition_version" > 0),
	CONSTRAINT "agent_runs_lease_pair_check" CHECK (("app_private"."agent_runs"."lease_owner" IS NULL AND "app_private"."agent_runs"."lease_expires_at" IS NULL)
        OR (
          "app_private"."agent_runs"."lease_owner" IS NOT NULL
          AND "app_private"."agent_runs"."lease_expires_at" IS NOT NULL
          AND
          length(btrim("app_private"."agent_runs"."lease_owner")) > 0
        )),
	CONSTRAINT "agent_runs_lifecycle_fields_check" CHECK ((
        "app_private"."agent_runs"."lifecycle" = 'queued'
        AND "app_private"."agent_runs"."lease_owner" IS NULL
        AND "app_private"."agent_runs"."started_at" IS NULL
        AND "app_private"."agent_runs"."completed_at" IS NULL
        AND "app_private"."agent_runs"."termination_reason" IS NULL
        AND "app_private"."agent_runs"."result_payload_version" IS NULL
      ) OR (
        "app_private"."agent_runs"."lifecycle" = 'leased'
        AND "app_private"."agent_runs"."lease_owner" IS NOT NULL
        AND "app_private"."agent_runs"."completed_at" IS NULL
        AND "app_private"."agent_runs"."termination_reason" IS NULL
        AND "app_private"."agent_runs"."result_payload_version" IS NULL
      ) OR (
        "app_private"."agent_runs"."lifecycle" = 'running'
        AND "app_private"."agent_runs"."lease_owner" IS NOT NULL
        AND "app_private"."agent_runs"."started_at" IS NOT NULL
        AND "app_private"."agent_runs"."completed_at" IS NULL
        AND "app_private"."agent_runs"."termination_reason" IS NULL
        AND "app_private"."agent_runs"."result_payload_version" IS NULL
      ) OR (
        "app_private"."agent_runs"."lifecycle" = 'completed'
        AND "app_private"."agent_runs"."lease_owner" IS NULL
        AND "app_private"."agent_runs"."started_at" IS NOT NULL
        AND "app_private"."agent_runs"."completed_at" IS NOT NULL
        AND "app_private"."agent_runs"."termination_reason" IS NULL
        AND "app_private"."agent_runs"."result_payload_version" IS NOT NULL
      ) OR (
        "app_private"."agent_runs"."lifecycle" = 'failed'
        AND "app_private"."agent_runs"."lease_owner" IS NULL
        AND "app_private"."agent_runs"."completed_at" IS NOT NULL
        AND "app_private"."agent_runs"."termination_reason" IS NOT NULL
      ) OR (
        "app_private"."agent_runs"."lifecycle" IN ('cancelled', 'stale')
        AND "app_private"."agent_runs"."lease_owner" IS NULL
        AND "app_private"."agent_runs"."completed_at" IS NOT NULL
        AND "app_private"."agent_runs"."termination_reason" IS NOT NULL
        AND "app_private"."agent_runs"."result_payload_version" IS NULL
      )),
	CONSTRAINT "agent_runs_timestamp_order_check" CHECK ("app_private"."agent_runs"."deadline_at" >= "app_private"."agent_runs"."created_at"
        AND ("app_private"."agent_runs"."started_at" IS NULL OR "app_private"."agent_runs"."started_at" >= "app_private"."agent_runs"."created_at")
        AND ("app_private"."agent_runs"."completed_at" IS NULL OR "app_private"."agent_runs"."completed_at" >= "app_private"."agent_runs"."created_at")
        AND (
          "app_private"."agent_runs"."started_at" IS NULL
          OR "app_private"."agent_runs"."completed_at" IS NULL
          OR "app_private"."agent_runs"."completed_at" >= "app_private"."agent_runs"."started_at"
        )
        AND (
          "app_private"."agent_runs"."lease_expires_at" IS NULL
          OR "app_private"."agent_runs"."lease_expires_at" > "app_private"."agent_runs"."updated_at"
        )),
	CONSTRAINT "agent_runs_required_payloads_check" CHECK ("app_private"."agent_runs"."run_config_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_runs"."run_config_payload") = 'object'
        AND "app_private"."agent_runs"."budget_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_runs"."budget_payload") = 'object'),
	CONSTRAINT "agent_runs_checkpoint_payload_check" CHECK ((
        "app_private"."agent_runs"."checkpoint_payload_version" IS NULL
        AND "app_private"."agent_runs"."checkpoint_payload" IS NULL
      ) OR (
        "app_private"."agent_runs"."checkpoint_payload_version" IS NOT NULL
        AND "app_private"."agent_runs"."checkpoint_payload" IS NOT NULL
        AND "app_private"."agent_runs"."checkpoint_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_runs"."checkpoint_payload") = 'object'
      )),
	CONSTRAINT "agent_runs_result_payload_check" CHECK ((
        "app_private"."agent_runs"."result_payload_version" IS NULL
        AND "app_private"."agent_runs"."result_payload" IS NULL
      ) OR (
        "app_private"."agent_runs"."result_payload_version" IS NOT NULL
        AND "app_private"."agent_runs"."result_payload" IS NOT NULL
        AND "app_private"."agent_runs"."result_payload_version" > 0
        AND jsonb_typeof("app_private"."agent_runs"."result_payload") = 'object'
      ))
);
--> statement-breakpoint
CREATE TABLE "app_private"."app_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"setting_key" text NOT NULL,
	"setting_payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_owner_key_unique" UNIQUE("owner_id","setting_key"),
	CONSTRAINT "app_settings_key_not_blank" CHECK (length(btrim("app_private"."app_settings"."setting_key")) > 0),
	CONSTRAINT "app_settings_payload_check" CHECK (jsonb_typeof("app_private"."app_settings"."setting_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_private"."command_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"canonical_payload_digest" text NOT NULL,
	"processing_status" text NOT NULL,
	"final_state_version" bigint,
	"first_event_seq" bigint,
	"last_event_seq" bigint,
	"response_payload_version" integer,
	"response_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_ledger_session_command_unique" UNIQUE("session_id","command_id"),
	CONSTRAINT "command_ledger_id_session_owner_unique" UNIQUE("id","session_id","owner_id"),
	CONSTRAINT "command_ledger_digest_check" CHECK ("app_private"."command_ledger"."canonical_payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "command_ledger_status_check" CHECK ("app_private"."command_ledger"."processing_status" IN ('processing', 'completed', 'failed')),
	CONSTRAINT "command_ledger_safe_values_check" CHECK (("app_private"."command_ledger"."final_state_version" IS NULL OR "app_private"."command_ledger"."final_state_version" BETWEEN 0 AND 9007199254740991)
        AND ("app_private"."command_ledger"."first_event_seq" IS NULL OR "app_private"."command_ledger"."first_event_seq" BETWEEN 0 AND 9007199254740991)
        AND ("app_private"."command_ledger"."last_event_seq" IS NULL OR "app_private"."command_ledger"."last_event_seq" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "command_ledger_event_range_check" CHECK (("app_private"."command_ledger"."first_event_seq" IS NULL AND "app_private"."command_ledger"."last_event_seq" IS NULL)
        OR (
          "app_private"."command_ledger"."first_event_seq" IS NOT NULL
          AND "app_private"."command_ledger"."last_event_seq" IS NOT NULL
          AND "app_private"."command_ledger"."first_event_seq" <= "app_private"."command_ledger"."last_event_seq"
        )),
	CONSTRAINT "command_ledger_response_payload_check" CHECK ((
        "app_private"."command_ledger"."response_payload_version" IS NULL
        AND "app_private"."command_ledger"."response_payload" IS NULL
      ) OR (
        "app_private"."command_ledger"."response_payload_version" IS NOT NULL
        AND "app_private"."command_ledger"."response_payload" IS NOT NULL
        AND "app_private"."command_ledger"."response_payload_version" > 0
        AND jsonb_typeof("app_private"."command_ledger"."response_payload") = 'object'
      ))
);
--> statement-breakpoint
CREATE TABLE "app_private"."hands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"hand_number" bigint NOT NULL,
	"status" text NOT NULL,
	"hand_start_checkpoint_payload_version" integer NOT NULL,
	"hand_start_checkpoint_payload" jsonb NOT NULL,
	"completed_result_payload_version" integer,
	"completed_result_payload" jsonb,
	"abort_reason" text,
	"aborted_by_agent_run_id" uuid,
	"button_seat" integer NOT NULL,
	"participant_seats" integer[] NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hands_session_hand_number_unique" UNIQUE("session_id","hand_number"),
	CONSTRAINT "hands_id_session_owner_unique" UNIQUE("id","session_id","owner_id"),
	CONSTRAINT "hands_id_owner_session_unique" UNIQUE("id","owner_id","session_id"),
	CONSTRAINT "hands_hand_number_safe" CHECK ("app_private"."hands"."hand_number" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "hands_status_check" CHECK ("app_private"."hands"."status" IN ('inProgress', 'completed', 'aborted')),
	CONSTRAINT "hands_checkpoint_payload_check" CHECK ("app_private"."hands"."hand_start_checkpoint_payload_version" > 0
        AND jsonb_typeof("app_private"."hands"."hand_start_checkpoint_payload") = 'object'),
	CONSTRAINT "hands_button_seat_check" CHECK ("app_private"."hands"."button_seat" BETWEEN 0 AND 8),
	CONSTRAINT "hands_participant_seats_check" CHECK (cardinality("app_private"."hands"."participant_seats") BETWEEN 6 AND 9
        AND "app_private"."hands"."participant_seats" <@ ARRAY[0,1,2,3,4,5,6,7,8]::integer[]
        AND "app_private"."hands"."participant_seats" @> ARRAY[0]::integer[]),
	CONSTRAINT "hands_participant_seats_unique_check" CHECK (cardinality("app_private"."hands"."participant_seats") = (
        ("app_private"."hands"."participant_seats" @> ARRAY[0]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[1]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[2]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[3]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[4]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[5]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[6]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[7]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[8]::integer[])::integer
      )),
	CONSTRAINT "hands_status_payload_check" CHECK ((
        "app_private"."hands"."status" = 'inProgress'
        AND "app_private"."hands"."completed_result_payload_version" IS NULL
        AND "app_private"."hands"."completed_result_payload" IS NULL
        AND "app_private"."hands"."completed_at" IS NULL
        AND "app_private"."hands"."abort_reason" IS NULL
        AND "app_private"."hands"."aborted_by_agent_run_id" IS NULL
        AND "app_private"."hands"."aborted_at" IS NULL
      ) OR (
        "app_private"."hands"."status" = 'completed'
        AND "app_private"."hands"."completed_result_payload_version" IS NOT NULL
        AND "app_private"."hands"."completed_result_payload" IS NOT NULL
        AND "app_private"."hands"."completed_result_payload_version" > 0
        AND jsonb_typeof("app_private"."hands"."completed_result_payload") = 'object'
        AND "app_private"."hands"."completed_at" IS NOT NULL
        AND "app_private"."hands"."abort_reason" IS NULL
        AND "app_private"."hands"."aborted_by_agent_run_id" IS NULL
        AND "app_private"."hands"."aborted_at" IS NULL
      ) OR (
        "app_private"."hands"."status" = 'aborted'
        AND "app_private"."hands"."completed_result_payload_version" IS NULL
        AND "app_private"."hands"."completed_result_payload" IS NULL
        AND "app_private"."hands"."completed_at" IS NULL
        AND "app_private"."hands"."abort_reason" IS NOT NULL
        AND length(btrim("app_private"."hands"."abort_reason")) > 0
        AND "app_private"."hands"."aborted_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "app_private"."owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identity_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_identity_key_unique" UNIQUE("identity_key"),
	CONSTRAINT "owners_identity_key_not_blank" CHECK (length(btrim("app_private"."owners"."identity_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app_private"."player_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"hand_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"source_state_version" bigint NOT NULL,
	"decision_request_id" uuid NOT NULL,
	"memory_revision" bigint NOT NULL,
	"runtime" text DEFAULT 'player' NOT NULL,
	"submission_status" text NOT NULL,
	"command_ledger_id" uuid,
	"decision_packet_payload_version" integer NOT NULL,
	"decision_packet_payload" jsonb NOT NULL,
	"candidate_set_payload_version" integer NOT NULL,
	"candidate_set_payload" jsonb NOT NULL,
	"validator_result_payload_version" integer NOT NULL,
	"validator_result_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "player_decisions_agent_run_unique" UNIQUE("agent_run_id"),
	CONSTRAINT "player_decisions_runtime_check" CHECK ("app_private"."player_decisions"."runtime" = 'player'),
	CONSTRAINT "player_decisions_submission_status_check" CHECK ("app_private"."player_decisions"."submission_status" IN ('pending', 'committed', 'rejected', 'stale')),
	CONSTRAINT "player_decisions_safe_values_check" CHECK ("app_private"."player_decisions"."source_state_version" BETWEEN 0 AND 9007199254740991
        AND "app_private"."player_decisions"."memory_revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "player_decisions_payloads_check" CHECK ("app_private"."player_decisions"."decision_packet_payload_version" > 0
        AND jsonb_typeof("app_private"."player_decisions"."decision_packet_payload") = 'object'
        AND "app_private"."player_decisions"."candidate_set_payload_version" > 0
        AND jsonb_typeof("app_private"."player_decisions"."candidate_set_payload") = 'object'
        AND "app_private"."player_decisions"."validator_result_payload_version" > 0
        AND jsonb_typeof("app_private"."player_decisions"."validator_result_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_private"."session_agents" (
	"participant_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"avatar_color" text NOT NULL,
	"persona_id" text NOT NULL,
	"persona_version" integer NOT NULL,
	"config_snapshot_key" text NOT NULL,
	"current_memory_revision" bigint DEFAULT 0 NOT NULL,
	"config_payload_version" integer NOT NULL,
	"config_payload" jsonb NOT NULL,
	"memory_payload_version" integer NOT NULL,
	"memory_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_agents_participant_session_owner_unique" UNIQUE("participant_id","session_id","owner_id"),
	CONSTRAINT "session_agents_config_identity_unique" UNIQUE("participant_id","session_id","owner_id","persona_id","persona_version","config_snapshot_key"),
	CONSTRAINT "session_agents_display_name_not_blank" CHECK (length(btrim("app_private"."session_agents"."display_name")) > 0),
	CONSTRAINT "session_agents_avatar_color_not_blank" CHECK (length(btrim("app_private"."session_agents"."avatar_color")) > 0),
	CONSTRAINT "session_agents_persona_id_not_blank" CHECK (length(btrim("app_private"."session_agents"."persona_id")) > 0),
	CONSTRAINT "session_agents_persona_version_positive" CHECK ("app_private"."session_agents"."persona_version" > 0),
	CONSTRAINT "session_agents_config_snapshot_key_check" CHECK ("app_private"."session_agents"."config_snapshot_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_agents_memory_revision_safe" CHECK ("app_private"."session_agents"."current_memory_revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "session_agents_config_payload_check" CHECK ("app_private"."session_agents"."config_payload_version" > 0
        AND jsonb_typeof("app_private"."session_agents"."config_payload") = 'object'),
	CONSTRAINT "session_agents_memory_payload_check" CHECK ("app_private"."session_agents"."memory_payload_version" > 0
        AND jsonb_typeof("app_private"."session_agents"."memory_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_private"."session_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"hand_id" uuid,
	"command_ledger_id" uuid,
	"event_seq" bigint NOT NULL,
	"state_version_before" bigint NOT NULL,
	"state_version_after" bigint NOT NULL,
	"private_event_payload_version" integer NOT NULL,
	"private_event_payload" jsonb NOT NULL,
	"public_event_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_session_event_seq_unique" UNIQUE("session_id","event_seq"),
	CONSTRAINT "session_events_safe_values_check" CHECK ("app_private"."session_events"."event_seq" BETWEEN 0 AND 9007199254740991
        AND "app_private"."session_events"."state_version_before" BETWEEN 0 AND 9007199254740991
        AND "app_private"."session_events"."state_version_after" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "session_events_private_payload_check" CHECK ("app_private"."session_events"."private_event_payload_version" > 0
        AND jsonb_typeof("app_private"."session_events"."private_event_payload") = 'object'),
	CONSTRAINT "session_events_public_payload_check" CHECK (jsonb_typeof("app_private"."session_events"."public_event_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_private"."session_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"participant_type" text NOT NULL,
	"seat_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_participants_session_seat_unique" UNIQUE("session_id","seat_number"),
	CONSTRAINT "session_participants_id_session_owner_unique" UNIQUE("id","session_id","owner_id"),
	CONSTRAINT "session_participants_identity_type_unique" UNIQUE("id","session_id","owner_id","participant_type"),
	CONSTRAINT "session_participants_type_check" CHECK ("app_private"."session_participants"."participant_type" IN ('user', 'agent')),
	CONSTRAINT "session_participants_seat_check" CHECK ("app_private"."session_participants"."seat_number" BETWEEN 0 AND 8),
	CONSTRAINT "session_participants_type_seat_check" CHECK (("app_private"."session_participants"."participant_type" = 'user' AND "app_private"."session_participants"."seat_number" = 0)
        OR ("app_private"."session_participants"."participant_type" = 'agent' AND "app_private"."session_participants"."seat_number" BETWEEN 1 AND 8))
);
--> statement-breakpoint
CREATE TABLE "app_private"."session_snapshots" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"private_table_state_payload_version" integer NOT NULL,
	"private_table_state_payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_snapshots_payload_check" CHECK ("app_private"."session_snapshots"."private_table_state_payload_version" > 0
        AND jsonb_typeof("app_private"."session_snapshots"."private_table_state_payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_private"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"state_version" bigint DEFAULT 0 NOT NULL,
	"next_event_seq" bigint DEFAULT 0 NOT NULL,
	"current_hand_id" uuid,
	"agent_run_state" text DEFAULT 'idle' NOT NULL,
	"active_player_run_id" uuid,
	"active_decision_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"diagnostic_code" text,
	"diagnosed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "sessions_lifecycle_status_check" CHECK ("app_private"."sessions"."lifecycle_status" IN ('active', 'ended', 'readonlyDiagnostic')),
	CONSTRAINT "sessions_state_version_safe_check" CHECK ("app_private"."sessions"."state_version" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "sessions_next_event_seq_safe_check" CHECK ("app_private"."sessions"."next_event_seq" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "sessions_agent_run_state_check" CHECK ("app_private"."sessions"."agent_run_state" IN ('idle', 'thinking', 'paused')),
	CONSTRAINT "sessions_active_player_pointer_check" CHECK ((
        "app_private"."sessions"."agent_run_state" = 'thinking'
        AND "app_private"."sessions"."active_player_run_id" IS NOT NULL
        AND "app_private"."sessions"."active_decision_request_id" IS NOT NULL
      ) OR (
        "app_private"."sessions"."agent_run_state" IN ('idle', 'paused')
        AND "app_private"."sessions"."active_player_run_id" IS NULL
        AND "app_private"."sessions"."active_decision_request_id" IS NULL
      )),
	CONSTRAINT "sessions_ended_at_check" CHECK (("app_private"."sessions"."lifecycle_status" = 'active' AND "app_private"."sessions"."ended_at" IS NULL)
        OR ("app_private"."sessions"."lifecycle_status" = 'ended' AND "app_private"."sessions"."ended_at" IS NOT NULL)
        OR ("app_private"."sessions"."lifecycle_status" = 'readonlyDiagnostic')),
	CONSTRAINT "sessions_diagnostic_fields_check" CHECK ((
        "app_private"."sessions"."lifecycle_status" = 'readonlyDiagnostic'
        AND "app_private"."sessions"."diagnostic_code" IS NOT NULL
        AND "app_private"."sessions"."diagnosed_at" IS NOT NULL
      ) OR (
        "app_private"."sessions"."lifecycle_status" <> 'readonlyDiagnostic'
        AND "app_private"."sessions"."diagnostic_code" IS NULL
        AND "app_private"."sessions"."diagnosed_at" IS NULL
      )),
	CONSTRAINT "sessions_diagnostic_code_check" CHECK ("app_private"."sessions"."diagnostic_code" IS NULL OR "app_private"."sessions"."diagnostic_code" IN (
        'eventSequenceInvalid',
        'eventVersionUnknown',
        'eventPayloadInvalid',
        'eventRowMismatch',
        'snapshotMissing',
        'snapshotVersionUnknown',
        'snapshotPayloadInvalid',
        'stateVersionMismatch',
        'handRelationshipInvalid'
      ))
);
--> statement-breakpoint
ALTER TABLE "app_private"."agent_attempts" ADD CONSTRAINT "agent_attempts_run_scope_fk" FOREIGN KEY ("agent_run_id","owner_id","session_id") REFERENCES "app_private"."agent_runs"("id","owner_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."agent_capability_invocations" ADD CONSTRAINT "agent_capability_invocations_run_scope_fk" FOREIGN KEY ("agent_run_id","owner_id","session_id") REFERENCES "app_private"."agent_runs"("id","owner_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."agent_memory_revisions" ADD CONSTRAINT "agent_memory_revisions_agent_scope_fk" FOREIGN KEY ("participant_id","session_id","owner_id") REFERENCES "app_private"."session_agents"("participant_id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs" ADD CONSTRAINT "agent_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs" ADD CONSTRAINT "agent_runs_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "app_private"."sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs" ADD CONSTRAINT "agent_runs_hand_scope_fk" FOREIGN KEY ("hand_id","owner_id","session_id") REFERENCES "app_private"."hands"("id","owner_id","session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs" ADD CONSTRAINT "agent_runs_participant_scope_fk" FOREIGN KEY ("participant_id","session_id","owner_id") REFERENCES "app_private"."session_agents"("participant_id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."app_settings" ADD CONSTRAINT "app_settings_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app_private"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."command_ledger" ADD CONSTRAINT "command_ledger_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."command_ledger" ADD CONSTRAINT "command_ledger_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "app_private"."sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."hands" ADD CONSTRAINT "hands_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."hands" ADD CONSTRAINT "hands_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "app_private"."sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_run_identity_fk" FOREIGN KEY ("agent_run_id","owner_id","session_id","hand_id","participant_id","source_state_version","decision_request_id","runtime") REFERENCES "app_private"."agent_runs"("id","owner_id","session_id","hand_id","participant_id","source_state_version","decision_request_id","runtime") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_agent_scope_fk" FOREIGN KEY ("participant_id","session_id","owner_id") REFERENCES "app_private"."session_agents"("participant_id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_memory_revision_fk" FOREIGN KEY ("participant_id","session_id","owner_id","memory_revision") REFERENCES "app_private"."agent_memory_revisions"("participant_id","session_id","owner_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."player_decisions" ADD CONSTRAINT "player_decisions_command_scope_fk" FOREIGN KEY ("command_ledger_id","session_id","owner_id") REFERENCES "app_private"."command_ledger"("id","session_id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_agents" ADD CONSTRAINT "session_agents_participant_id_session_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "app_private"."session_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_agents" ADD CONSTRAINT "session_agents_participant_scope_fk" FOREIGN KEY ("participant_id","session_id","owner_id") REFERENCES "app_private"."session_participants"("id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_events" ADD CONSTRAINT "session_events_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "app_private"."sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_events" ADD CONSTRAINT "session_events_hand_scope_fk" FOREIGN KEY ("hand_id","session_id","owner_id") REFERENCES "app_private"."hands"("id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_events" ADD CONSTRAINT "session_events_command_scope_fk" FOREIGN KEY ("command_ledger_id","session_id","owner_id") REFERENCES "app_private"."command_ledger"("id","session_id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_participants" ADD CONSTRAINT "session_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_participants" ADD CONSTRAINT "session_participants_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "app_private"."sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_snapshots" ADD CONSTRAINT "session_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app_private"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."session_snapshots" ADD CONSTRAINT "session_snapshots_session_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "app_private"."sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_private"."sessions" ADD CONSTRAINT "sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app_private"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_attempts_session_created_idx" ON "app_private"."agent_attempts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_capability_invocations_capability_idx" ON "app_private"."agent_capability_invocations" USING btree ("capability_name","capability_version","created_at");--> statement-breakpoint
CREATE INDEX "agent_memory_revisions_session_idx" ON "app_private"."agent_memory_revisions" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active_player_decision" ON "app_private"."agent_runs" USING btree ("session_id","source_state_version","participant_id") WHERE "app_private"."agent_runs"."runtime" = 'player'
          AND "app_private"."agent_runs"."lifecycle" IN ('queued', 'leased', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_runtime_concurrency_idx" ON "app_private"."agent_runs" USING btree ("runtime","lifecycle","owner_id","lease_expires_at") WHERE "app_private"."agent_runs"."lifecycle" IN ('leased', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_worker_claim_idx" ON "app_private"."agent_runs" USING btree ("runtime","lifecycle","lease_expires_at","deadline_at","created_at","id");--> statement-breakpoint
CREATE INDEX "agent_runs_session_created_idx" ON "app_private"."agent_runs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_hand_runtime_idx" ON "app_private"."agent_runs" USING btree ("hand_id","runtime");--> statement-breakpoint
CREATE INDEX "agent_runs_participant_created_idx" ON "app_private"."agent_runs" USING btree ("participant_id","created_at");--> statement-breakpoint
CREATE INDEX "command_ledger_session_status_idx" ON "app_private"."command_ledger" USING btree ("session_id","processing_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hands_one_in_progress_per_session" ON "app_private"."hands" USING btree ("session_id") WHERE "app_private"."hands"."status" = 'inProgress';--> statement-breakpoint
CREATE INDEX "hands_session_status_started_idx" ON "app_private"."hands" USING btree ("session_id","status","started_at");--> statement-breakpoint
CREATE INDEX "player_decisions_hand_participant_version_idx" ON "app_private"."player_decisions" USING btree ("hand_id","participant_id","source_state_version");--> statement-breakpoint
CREATE INDEX "session_agents_session_idx" ON "app_private"."session_agents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_agents_persona_config_idx" ON "app_private"."session_agents" USING btree ("persona_id","persona_version","config_snapshot_key");--> statement-breakpoint
CREATE INDEX "session_events_session_created_idx" ON "app_private"."session_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_events_hand_event_seq_idx" ON "app_private"."session_events" USING btree ("hand_id","event_seq");--> statement-breakpoint
CREATE INDEX "session_participants_session_type_idx" ON "app_private"."session_participants" USING btree ("session_id","participant_type");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_active_per_owner" ON "app_private"."sessions" USING btree ("owner_id") WHERE "app_private"."sessions"."lifecycle_status" = 'active';--> statement-breakpoint
CREATE INDEX "sessions_owner_status_updated_idx" ON "app_private"."sessions" USING btree ("owner_id","lifecycle_status","updated_at");
--> statement-breakpoint
ALTER TABLE "app_private"."sessions"
ADD CONSTRAINT "sessions_current_hand_scope_fk"
FOREIGN KEY ("current_hand_id", "id", "owner_id")
REFERENCES "app_private"."hands" ("id", "session_id", "owner_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION "app_private"."enforce_session_roster"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  affected_session_id uuid;
  affected_session_ids uuid[];
  user_count integer;
  agent_count integer;
  participant_count integer;
  invalid_agent_links integer;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    affected_session_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    affected_session_ids := ARRAY[NEW.session_id];
  ELSIF TG_OP = 'DELETE' THEN
    affected_session_ids := ARRAY[OLD.session_id];
  ELSIF NEW.session_id = OLD.session_id THEN
    affected_session_ids := ARRAY[NEW.session_id];
  ELSE
    affected_session_ids := ARRAY[OLD.session_id, NEW.session_id];
  END IF;

  FOREACH affected_session_id IN ARRAY affected_session_ids LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1
      FROM app_private.sessions AS target_session
      WHERE target_session.id = affected_session_id
    );

    SELECT
      count(*) FILTER (
        WHERE participant.participant_type = 'user'
          AND participant.seat_number = 0
      ),
      count(*) FILTER (
        WHERE participant.participant_type = 'agent'
          AND participant.seat_number BETWEEN 1 AND 8
      ),
      count(*),
      count(*) FILTER (
        WHERE (
          participant.participant_type = 'agent'
          AND NOT EXISTS (
            SELECT 1
            FROM app_private.session_agents AS agent
            WHERE agent.participant_id = participant.id
              AND agent.session_id = participant.session_id
              AND agent.owner_id = participant.owner_id
          )
        ) OR (
          participant.participant_type = 'user'
          AND EXISTS (
            SELECT 1
            FROM app_private.session_agents AS agent
            WHERE agent.participant_id = participant.id
          )
        )
      )
    INTO
      user_count,
      agent_count,
      participant_count,
      invalid_agent_links
    FROM app_private.session_participants AS participant
    WHERE participant.session_id = affected_session_id;

    IF user_count <> 1
      OR agent_count NOT BETWEEN 5 AND 8
      OR participant_count NOT BETWEEN 6 AND 9
      OR invalid_agent_links <> 0
    THEN
      RAISE EXCEPTION
        'session % has an invalid participant roster',
        affected_session_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sessions_roster_integrity"
AFTER INSERT ON "app_private"."sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_session_roster"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_participants_roster_integrity"
AFTER INSERT OR UPDATE OR DELETE ON "app_private"."session_participants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_session_roster"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_agents_roster_integrity"
AFTER INSERT OR UPDATE OR DELETE ON "app_private"."session_agents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_session_roster"();
--> statement-breakpoint
ALTER TABLE "app_private"."sessions"
ADD CONSTRAINT "sessions_active_player_run_fk"
FOREIGN KEY (
  "active_player_run_id",
  "id",
  "owner_id",
  "active_decision_request_id"
)
REFERENCES "app_private"."agent_runs" (
  "id",
  "session_id",
  "owner_id",
  "decision_request_id"
)
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "app_private"."session_agents"
ADD CONSTRAINT "session_agents_current_memory_revision_fk"
FOREIGN KEY (
  "participant_id",
  "session_id",
  "owner_id",
  "current_memory_revision"
)
REFERENCES "app_private"."agent_memory_revisions" (
  "participant_id",
  "session_id",
  "owner_id",
  "revision"
)
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "app_private"."hands"
ADD CONSTRAINT "hands_aborted_by_agent_run_fk"
FOREIGN KEY ("aborted_by_agent_run_id", "owner_id", "session_id")
REFERENCES "app_private"."agent_runs" ("id", "owner_id", "session_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs"
ADD CONSTRAINT "agent_runs_parent_scope_fk"
FOREIGN KEY ("parent_run_id", "owner_id", "session_id")
REFERENCES "app_private"."agent_runs" ("id", "owner_id", "session_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "app_private"."agent_runs"
ADD CONSTRAINT "agent_runs_replacement_scope_fk"
FOREIGN KEY ("replacement_run_id", "owner_id", "session_id")
REFERENCES "app_private"."agent_runs" ("id", "owner_id", "session_id")
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION "app_private"."enforce_player_run_coordination"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  affected_session_id uuid;
  affected_session_ids uuid[];
  session_run_state text;
  session_active_run_id uuid;
  session_active_request_id uuid;
  active_run_count integer;
  matching_run_count integer;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    IF TG_OP = 'DELETE' THEN
      affected_session_ids := ARRAY[OLD.id];
    ELSIF TG_OP = 'INSERT' THEN
      affected_session_ids := ARRAY[NEW.id];
    ELSIF NEW.id = OLD.id THEN
      affected_session_ids := ARRAY[NEW.id];
    ELSE
      affected_session_ids := ARRAY[OLD.id, NEW.id];
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    affected_session_ids := ARRAY[NEW.session_id];
  ELSIF TG_OP = 'DELETE' THEN
    affected_session_ids := ARRAY[OLD.session_id];
  ELSIF NEW.session_id = OLD.session_id THEN
    affected_session_ids := ARRAY[NEW.session_id];
  ELSE
    affected_session_ids := ARRAY[OLD.session_id, NEW.session_id];
  END IF;

  FOREACH affected_session_id IN ARRAY affected_session_ids LOOP
    SELECT
      target_session.agent_run_state,
      target_session.active_player_run_id,
      target_session.active_decision_request_id
    INTO
      session_run_state,
      session_active_run_id,
      session_active_request_id
    FROM app_private.sessions AS target_session
    WHERE target_session.id = affected_session_id;

    CONTINUE WHEN NOT FOUND;

    SELECT
      count(*),
      count(*) FILTER (
        WHERE run.id = session_active_run_id
          AND run.decision_request_id = session_active_request_id
      )
    INTO active_run_count, matching_run_count
    FROM app_private.agent_runs AS run
    WHERE run.session_id = affected_session_id
      AND run.runtime = 'player'
      AND run.lifecycle IN ('queued', 'leased', 'running');

    IF (
      session_run_state = 'thinking'
      AND (active_run_count <> 1 OR matching_run_count <> 1)
    ) OR (
      session_run_state IN ('idle', 'paused')
      AND active_run_count <> 0
    )
    THEN
      RAISE EXCEPTION
        'session % has invalid active player run coordination',
        affected_session_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sessions_player_run_coordination"
AFTER INSERT OR UPDATE OR DELETE ON "app_private"."sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_player_run_coordination"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_runs_player_run_coordination"
AFTER INSERT OR UPDATE OR DELETE ON "app_private"."agent_runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_player_run_coordination"();
--> statement-breakpoint
CREATE FUNCTION "app_private"."enforce_coach_completed_hand"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app_private
AS $$
DECLARE
  affected_session_id uuid;
  affected_hand_id uuid;
  hand_status text;
BEGIN
  IF TG_TABLE_NAME = 'hands' THEN
    affected_session_id := NEW.session_id;
    affected_hand_id := NEW.id;
  ELSE
    affected_session_id := NEW.session_id;
    affected_hand_id := NEW.hand_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app_private.sessions AS target_session
    WHERE target_session.id = affected_session_id
  ) THEN
    RETURN NULL;
  END IF;

  SELECT target_hand.status
  INTO hand_status
  FROM app_private.hands AS target_hand
  WHERE target_hand.id = affected_hand_id
    AND target_hand.session_id = affected_session_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF hand_status <> 'completed'
    AND EXISTS (
      SELECT 1
      FROM app_private.agent_runs AS run
      WHERE run.session_id = affected_session_id
        AND run.hand_id = affected_hand_id
        AND run.runtime = 'coach'
    )
  THEN
    RAISE EXCEPTION
      'coach data requires completed hand %',
      affected_hand_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_runs_coach_completed_hand"
AFTER INSERT OR UPDATE ON "app_private"."agent_runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_coach_completed_hand"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "hands_coach_completed_hand"
AFTER UPDATE OF "status" ON "app_private"."hands"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "app_private"."enforce_coach_completed_hand"();
--> statement-breakpoint
INSERT INTO "app_private"."owners" ("id", "identity_key")
VALUES ('11111111-1111-4111-8111-111111111111', 'local-user');
--> statement-breakpoint
REVOKE ALL ON SCHEMA "app_private" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "app_private" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "app_private" FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = role_name
    ) THEN
      EXECUTE format(
        'REVOKE ALL ON SCHEMA app_private FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL ON ALL TABLES IN SCHEMA app_private FROM %I',
        role_name
      );
      EXECUTE format(
        'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END;
$$;
