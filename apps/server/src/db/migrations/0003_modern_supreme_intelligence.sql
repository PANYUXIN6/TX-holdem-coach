ALTER TABLE "app_private"."sessions" ADD COLUMN "diagnostic_code" text;--> statement-breakpoint
ALTER TABLE "app_private"."sessions" ADD COLUMN "diagnosed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "app_private"."sessions"
SET "diagnostic_code" = 'legacyDiagnosticState',
    "diagnosed_at" = "updated_at"
WHERE "lifecycle_status" = 'readonlyDiagnostic';--> statement-breakpoint
ALTER TABLE "app_private"."sessions" DROP CONSTRAINT "sessions_ended_at_check";--> statement-breakpoint
ALTER TABLE "app_private"."sessions" ADD CONSTRAINT "sessions_diagnostic_fields_check" CHECK ((
        "app_private"."sessions"."lifecycle_status" = 'readonlyDiagnostic'
        AND "app_private"."sessions"."diagnostic_code" IS NOT NULL
        AND "app_private"."sessions"."diagnosed_at" IS NOT NULL
      ) OR (
        "app_private"."sessions"."lifecycle_status" <> 'readonlyDiagnostic'
        AND "app_private"."sessions"."diagnostic_code" IS NULL
        AND "app_private"."sessions"."diagnosed_at" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "app_private"."sessions" ADD CONSTRAINT "sessions_diagnostic_code_check" CHECK ("app_private"."sessions"."diagnostic_code" IS NULL OR "app_private"."sessions"."diagnostic_code" IN (
        'legacyDiagnosticState',
        'eventSequenceInvalid',
        'eventVersionUnknown',
        'eventPayloadInvalid',
        'eventRowMismatch',
        'snapshotMissing',
        'snapshotVersionUnknown',
        'snapshotPayloadInvalid',
        'stateVersionMismatch',
        'handRelationshipInvalid'
      ));--> statement-breakpoint
ALTER TABLE "app_private"."sessions" ADD CONSTRAINT "sessions_ended_at_check" CHECK (("app_private"."sessions"."lifecycle_status" = 'active' AND "app_private"."sessions"."ended_at" IS NULL)
        OR ("app_private"."sessions"."lifecycle_status" = 'ended' AND "app_private"."sessions"."ended_at" IS NOT NULL)
        OR ("app_private"."sessions"."lifecycle_status" = 'readonlyDiagnostic'));
