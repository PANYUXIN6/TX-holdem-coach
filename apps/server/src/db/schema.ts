import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const appPrivateSchema = pgSchema('app_private')

const safeBigint = (name: string) => bigint(name, { mode: 'number' })
const zonedTimestamp = (name: string) => timestamp(name, { withTimezone: true })
const objectPayload = (name: string) =>
  jsonb(name).$type<Record<string, unknown>>()

export const LOCAL_USER_OWNER_ID = '11111111-1111-4111-8111-111111111111'
export const LOCAL_USER_IDENTITY_KEY = 'local-user'

export const owners = appPrivateSchema.table(
  'owners',
  {
    id: uuid('id').primaryKey(),
    identityKey: text('identity_key').notNull(),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('owners_identity_key_unique').on(table.identityKey),
    check(
      'owners_identity_key_not_blank',
      sql`length(btrim(${table.identityKey})) > 0`,
    ),
  ],
)

export const sessions = appPrivateSchema.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    lifecycleStatus: text('lifecycle_status').notNull().default('active'),
    stateVersion: safeBigint('state_version').notNull().default(0),
    nextEventSeq: safeBigint('next_event_seq').notNull().default(0),
    currentHandId: uuid('current_hand_id'),
    agentRunState: text('agent_run_state').notNull().default('idle'),
    activePlayerRunId: uuid('active_player_run_id'),
    activeDecisionRequestId: uuid('active_decision_request_id'),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
    endedAt: zonedTimestamp('ended_at'),
    diagnosticCode: text('diagnostic_code'),
    diagnosedAt: zonedTimestamp('diagnosed_at'),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('sessions_id_owner_unique').on(table.id, table.ownerId),
    uniqueIndex('sessions_one_active_per_owner')
      .on(table.ownerId)
      .where(sql`${table.lifecycleStatus} = 'active'`),
    index('sessions_owner_status_updated_idx').on(
      table.ownerId,
      table.lifecycleStatus,
      table.updatedAt,
    ),
    check(
      'sessions_lifecycle_status_check',
      sql`${table.lifecycleStatus} IN ('active', 'ended', 'readonlyDiagnostic')`,
    ),
    check(
      'sessions_state_version_safe_check',
      sql`${table.stateVersion} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'sessions_next_event_seq_safe_check',
      sql`${table.nextEventSeq} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'sessions_agent_run_state_check',
      sql`${table.agentRunState} IN ('idle', 'thinking', 'paused')`,
    ),
    check(
      'sessions_active_player_pointer_check',
      sql`(
        ${table.agentRunState} = 'thinking'
        AND ${table.activePlayerRunId} IS NOT NULL
        AND ${table.activeDecisionRequestId} IS NOT NULL
      ) OR (
        ${table.agentRunState} IN ('idle', 'paused')
        AND ${table.activePlayerRunId} IS NULL
        AND ${table.activeDecisionRequestId} IS NULL
      )`,
    ),
    check(
      'sessions_ended_at_check',
      sql`(${table.lifecycleStatus} = 'active' AND ${table.endedAt} IS NULL)
        OR (${table.lifecycleStatus} = 'ended' AND ${table.endedAt} IS NOT NULL)
        OR (${table.lifecycleStatus} = 'readonlyDiagnostic')`,
    ),
    check(
      'sessions_diagnostic_fields_check',
      sql`(
        ${table.lifecycleStatus} = 'readonlyDiagnostic'
        AND ${table.diagnosticCode} IS NOT NULL
        AND ${table.diagnosedAt} IS NOT NULL
      ) OR (
        ${table.lifecycleStatus} <> 'readonlyDiagnostic'
        AND ${table.diagnosticCode} IS NULL
        AND ${table.diagnosedAt} IS NULL
      )`,
    ),
    check(
      'sessions_diagnostic_code_check',
      sql`${table.diagnosticCode} IS NULL OR ${table.diagnosticCode} IN (
        'eventSequenceInvalid',
        'eventVersionUnknown',
        'eventPayloadInvalid',
        'eventRowMismatch',
        'snapshotMissing',
        'snapshotVersionUnknown',
        'snapshotPayloadInvalid',
        'stateVersionMismatch',
        'handRelationshipInvalid'
      )`,
    ),
  ],
)

export const sessionParticipants = appPrivateSchema.table(
  'session_participants',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    participantType: text('participant_type').notNull(),
    seatNumber: integer('seat_number').notNull(),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'session_participants_session_owner_fk',
      columns: [table.sessionId, table.ownerId],
      foreignColumns: [sessions.id, sessions.ownerId],
    }).onDelete('cascade'),
    unique('session_participants_session_seat_unique').on(
      table.sessionId,
      table.seatNumber,
    ),
    unique('session_participants_id_session_owner_unique').on(
      table.id,
      table.sessionId,
      table.ownerId,
    ),
    unique('session_participants_identity_type_unique').on(
      table.id,
      table.sessionId,
      table.ownerId,
      table.participantType,
    ),
    index('session_participants_session_type_idx').on(
      table.sessionId,
      table.participantType,
    ),
    check(
      'session_participants_type_check',
      sql`${table.participantType} IN ('user', 'agent')`,
    ),
    check(
      'session_participants_seat_check',
      sql`${table.seatNumber} BETWEEN 0 AND 8`,
    ),
    check(
      'session_participants_type_seat_check',
      sql`(${table.participantType} = 'user' AND ${table.seatNumber} = 0)
        OR (${table.participantType} = 'agent' AND ${table.seatNumber} BETWEEN 1 AND 8)`,
    ),
  ],
)

export const sessionAgents = appPrivateSchema.table(
  'session_agents',
  {
    participantId: uuid('participant_id')
      .primaryKey()
      .references(() => sessionParticipants.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    displayName: text('display_name').notNull(),
    avatarColor: text('avatar_color').notNull(),
    personaId: text('persona_id').notNull(),
    personaVersion: integer('persona_version').notNull(),
    configSnapshotKey: text('config_snapshot_key').notNull(),
    currentMemoryRevision: safeBigint('current_memory_revision')
      .notNull()
      .default(0),
    configPayloadVersion: integer('config_payload_version').notNull(),
    configPayload: objectPayload('config_payload').notNull(),
    memoryPayloadVersion: integer('memory_payload_version').notNull(),
    memoryPayload: objectPayload('memory_payload').notNull(),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'session_agents_participant_scope_fk',
      columns: [table.participantId, table.sessionId, table.ownerId],
      foreignColumns: [
        sessionParticipants.id,
        sessionParticipants.sessionId,
        sessionParticipants.ownerId,
      ],
    }).onDelete('cascade'),
    unique('session_agents_participant_session_owner_unique').on(
      table.participantId,
      table.sessionId,
      table.ownerId,
    ),
    unique('session_agents_config_identity_unique').on(
      table.participantId,
      table.sessionId,
      table.ownerId,
      table.personaId,
      table.personaVersion,
      table.configSnapshotKey,
    ),
    index('session_agents_session_idx').on(table.sessionId),
    index('session_agents_persona_config_idx').on(
      table.personaId,
      table.personaVersion,
      table.configSnapshotKey,
    ),
    check(
      'session_agents_display_name_not_blank',
      sql`length(btrim(${table.displayName})) > 0`,
    ),
    check(
      'session_agents_avatar_color_not_blank',
      sql`length(btrim(${table.avatarColor})) > 0`,
    ),
    check(
      'session_agents_persona_id_not_blank',
      sql`length(btrim(${table.personaId})) > 0`,
    ),
    check(
      'session_agents_persona_version_positive',
      sql`${table.personaVersion} > 0`,
    ),
    check(
      'session_agents_config_snapshot_key_check',
      sql`${table.configSnapshotKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'session_agents_memory_revision_safe',
      sql`${table.currentMemoryRevision} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'session_agents_config_payload_check',
      sql`${table.configPayloadVersion} > 0
        AND jsonb_typeof(${table.configPayload}) = 'object'`,
    ),
    check(
      'session_agents_memory_payload_check',
      sql`${table.memoryPayloadVersion} > 0
        AND jsonb_typeof(${table.memoryPayload}) = 'object'`,
    ),
  ],
)

export const agentMemoryRevisions = appPrivateSchema.table(
  'agent_memory_revisions',
  {
    participantId: uuid('participant_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    revision: safeBigint('revision').notNull(),
    memoryPayloadVersion: integer('memory_payload_version').notNull(),
    memoryPayload: objectPayload('memory_payload').notNull(),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'agent_memory_revisions_pk',
      columns: [table.participantId, table.revision],
    }),
    foreignKey({
      name: 'agent_memory_revisions_agent_scope_fk',
      columns: [table.participantId, table.sessionId, table.ownerId],
      foreignColumns: [
        sessionAgents.participantId,
        sessionAgents.sessionId,
        sessionAgents.ownerId,
      ],
    }).onDelete('cascade'),
    unique('agent_memory_revisions_scope_revision_unique').on(
      table.participantId,
      table.sessionId,
      table.ownerId,
      table.revision,
    ),
    index('agent_memory_revisions_session_idx').on(table.sessionId),
    check(
      'agent_memory_revisions_revision_safe',
      sql`${table.revision} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'agent_memory_revisions_payload_check',
      sql`${table.memoryPayloadVersion} > 0
        AND jsonb_typeof(${table.memoryPayload}) = 'object'`,
    ),
  ],
)

export const hands = appPrivateSchema.table(
  'hands',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    handNumber: safeBigint('hand_number').notNull(),
    status: text('status').notNull(),
    handStartCheckpointPayloadVersion: integer(
      'hand_start_checkpoint_payload_version',
    ).notNull(),
    handStartCheckpointPayload: objectPayload(
      'hand_start_checkpoint_payload',
    ).notNull(),
    completedResultPayloadVersion: integer('completed_result_payload_version'),
    completedResultPayload: objectPayload('completed_result_payload'),
    abortReason: text('abort_reason'),
    abortedByAgentRunId: uuid('aborted_by_agent_run_id'),
    buttonSeat: integer('button_seat').notNull(),
    participantSeats: integer('participant_seats').array().notNull(),
    startedAt: zonedTimestamp('started_at').notNull(),
    completedAt: zonedTimestamp('completed_at'),
    abortedAt: zonedTimestamp('aborted_at'),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'hands_session_owner_fk',
      columns: [table.sessionId, table.ownerId],
      foreignColumns: [sessions.id, sessions.ownerId],
    }).onDelete('cascade'),
    unique('hands_session_hand_number_unique').on(
      table.sessionId,
      table.handNumber,
    ),
    unique('hands_id_session_owner_unique').on(
      table.id,
      table.sessionId,
      table.ownerId,
    ),
    unique('hands_id_owner_session_unique').on(
      table.id,
      table.ownerId,
      table.sessionId,
    ),
    uniqueIndex('hands_one_in_progress_per_session')
      .on(table.sessionId)
      .where(sql`${table.status} = 'inProgress'`),
    index('hands_session_status_started_idx').on(
      table.sessionId,
      table.status,
      table.startedAt,
    ),
    check(
      'hands_hand_number_safe',
      sql`${table.handNumber} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'hands_status_check',
      sql`${table.status} IN ('inProgress', 'completed', 'aborted')`,
    ),
    check(
      'hands_checkpoint_payload_check',
      sql`${table.handStartCheckpointPayloadVersion} > 0
        AND jsonb_typeof(${table.handStartCheckpointPayload}) = 'object'`,
    ),
    check('hands_button_seat_check', sql`${table.buttonSeat} BETWEEN 0 AND 8`),
    check(
      'hands_participant_seats_check',
      sql`cardinality(${table.participantSeats}) BETWEEN 6 AND 9
        AND ${table.participantSeats} <@ ARRAY[0,1,2,3,4,5,6,7,8]::integer[]
        AND ${table.participantSeats} @> ARRAY[0]::integer[]`,
    ),
    check(
      'hands_participant_seats_unique_check',
      sql`cardinality(${table.participantSeats}) = (
        (${table.participantSeats} @> ARRAY[0]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[1]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[2]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[3]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[4]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[5]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[6]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[7]::integer[])::integer
        + (${table.participantSeats} @> ARRAY[8]::integer[])::integer
      )`,
    ),
    check(
      'hands_status_payload_check',
      sql`(
        ${table.status} = 'inProgress'
        AND ${table.completedResultPayloadVersion} IS NULL
        AND ${table.completedResultPayload} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.abortReason} IS NULL
        AND ${table.abortedByAgentRunId} IS NULL
        AND ${table.abortedAt} IS NULL
      ) OR (
        ${table.status} = 'completed'
        AND ${table.completedResultPayloadVersion} IS NOT NULL
        AND ${table.completedResultPayload} IS NOT NULL
        AND ${table.completedResultPayloadVersion} > 0
        AND jsonb_typeof(${table.completedResultPayload}) = 'object'
        AND ${table.completedAt} IS NOT NULL
        AND ${table.abortReason} IS NULL
        AND ${table.abortedByAgentRunId} IS NULL
        AND ${table.abortedAt} IS NULL
      ) OR (
        ${table.status} = 'aborted'
        AND ${table.completedResultPayloadVersion} IS NULL
        AND ${table.completedResultPayload} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.abortReason} IS NOT NULL
        AND length(btrim(${table.abortReason})) > 0
        AND ${table.abortedAt} IS NOT NULL
      )`,
    ),
  ],
)

export const commandLedger = appPrivateSchema.table(
  'command_ledger',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    commandId: uuid('command_id').notNull(),
    canonicalPayloadDigest: text('canonical_payload_digest').notNull(),
    processingStatus: text('processing_status').notNull(),
    finalStateVersion: safeBigint('final_state_version'),
    firstEventSeq: safeBigint('first_event_seq'),
    lastEventSeq: safeBigint('last_event_seq'),
    responsePayloadVersion: integer('response_payload_version'),
    responsePayload: objectPayload('response_payload'),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
    completedAt: zonedTimestamp('completed_at'),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'command_ledger_session_owner_fk',
      columns: [table.sessionId, table.ownerId],
      foreignColumns: [sessions.id, sessions.ownerId],
    }).onDelete('cascade'),
    unique('command_ledger_session_command_unique').on(
      table.sessionId,
      table.commandId,
    ),
    unique('command_ledger_id_session_owner_unique').on(
      table.id,
      table.sessionId,
      table.ownerId,
    ),
    index('command_ledger_session_status_idx').on(
      table.sessionId,
      table.processingStatus,
      table.createdAt,
    ),
    check(
      'command_ledger_digest_check',
      sql`${table.canonicalPayloadDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'command_ledger_status_check',
      sql`${table.processingStatus} IN ('processing', 'completed', 'failed')`,
    ),
    check(
      'command_ledger_safe_values_check',
      sql`(${table.finalStateVersion} IS NULL OR ${table.finalStateVersion} BETWEEN 0 AND 9007199254740991)
        AND (${table.firstEventSeq} IS NULL OR ${table.firstEventSeq} BETWEEN 0 AND 9007199254740991)
        AND (${table.lastEventSeq} IS NULL OR ${table.lastEventSeq} BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      'command_ledger_event_range_check',
      sql`(${table.firstEventSeq} IS NULL AND ${table.lastEventSeq} IS NULL)
        OR (
          ${table.firstEventSeq} IS NOT NULL
          AND ${table.lastEventSeq} IS NOT NULL
          AND ${table.firstEventSeq} <= ${table.lastEventSeq}
        )`,
    ),
    check(
      'command_ledger_response_payload_check',
      sql`(
        ${table.responsePayloadVersion} IS NULL
        AND ${table.responsePayload} IS NULL
      ) OR (
        ${table.responsePayloadVersion} IS NOT NULL
        AND ${table.responsePayload} IS NOT NULL
        AND ${table.responsePayloadVersion} > 0
        AND jsonb_typeof(${table.responsePayload}) = 'object'
      )`,
    ),
  ],
)

export const sessionEvents = appPrivateSchema.table(
  'session_events',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    handId: uuid('hand_id'),
    commandLedgerId: uuid('command_ledger_id'),
    eventSeq: safeBigint('event_seq').notNull(),
    stateVersionBefore: safeBigint('state_version_before').notNull(),
    stateVersionAfter: safeBigint('state_version_after').notNull(),
    privateEventPayloadVersion: integer(
      'private_event_payload_version',
    ).notNull(),
    privateEventPayload: objectPayload('private_event_payload').notNull(),
    publicEventPayload: objectPayload('public_event_payload').notNull(),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'session_events_session_owner_fk',
      columns: [table.sessionId, table.ownerId],
      foreignColumns: [sessions.id, sessions.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'session_events_hand_scope_fk',
      columns: [table.handId, table.sessionId, table.ownerId],
      foreignColumns: [hands.id, hands.sessionId, hands.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'session_events_command_scope_fk',
      columns: [table.commandLedgerId, table.sessionId, table.ownerId],
      foreignColumns: [
        commandLedger.id,
        commandLedger.sessionId,
        commandLedger.ownerId,
      ],
    }).onDelete('cascade'),
    unique('session_events_session_event_seq_unique').on(
      table.sessionId,
      table.eventSeq,
    ),
    index('session_events_session_created_idx').on(
      table.sessionId,
      table.createdAt,
    ),
    index('session_events_hand_event_seq_idx').on(table.handId, table.eventSeq),
    check(
      'session_events_safe_values_check',
      sql`${table.eventSeq} BETWEEN 0 AND 9007199254740991
        AND ${table.stateVersionBefore} BETWEEN 0 AND 9007199254740991
        AND ${table.stateVersionAfter} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'session_events_private_payload_check',
      sql`${table.privateEventPayloadVersion} > 0
        AND jsonb_typeof(${table.privateEventPayload}) = 'object'`,
    ),
    check(
      'session_events_public_payload_check',
      sql`jsonb_typeof(${table.publicEventPayload}) = 'object'`,
    ),
  ],
)

export const sessionSnapshots = appPrivateSchema.table(
  'session_snapshots',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull(),
    privateTableStatePayloadVersion: integer(
      'private_table_state_payload_version',
    ).notNull(),
    privateTableStatePayload: objectPayload(
      'private_table_state_payload',
    ).notNull(),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'session_snapshots_session_owner_fk',
      columns: [table.sessionId, table.ownerId],
      foreignColumns: [sessions.id, sessions.ownerId],
    }).onDelete('cascade'),
    check(
      'session_snapshots_payload_check',
      sql`${table.privateTableStatePayloadVersion} > 0
        AND jsonb_typeof(${table.privateTableStatePayload}) = 'object'`,
    ),
  ],
)

export const agentRuns = appPrivateSchema.table(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runtime: text('runtime').notNull(),
    triggerType: text('trigger_type').notNull(),
    lifecycle: text('lifecycle').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    handId: uuid('hand_id').notNull(),
    participantId: uuid('participant_id'),
    sourceStateVersion: safeBigint('source_state_version'),
    decisionRequestId: uuid('decision_request_id'),
    parentRunId: uuid('parent_run_id'),
    replacementRunId: uuid('replacement_run_id'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: zonedTimestamp('lease_expires_at'),
    fencingToken: safeBigint('fencing_token').notNull().default(0),
    deadlineAt: zonedTimestamp('deadline_at').notNull(),
    runtimeDefinitionVersion: integer('runtime_definition_version').notNull(),
    terminationReason: text('termination_reason'),
    runConfigPayloadVersion: integer('run_config_payload_version').notNull(),
    runConfigPayload: objectPayload('run_config_payload').notNull(),
    budgetPayloadVersion: integer('budget_payload_version').notNull(),
    budgetPayload: objectPayload('budget_payload').notNull(),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
    startedAt: zonedTimestamp('started_at'),
    completedAt: zonedTimestamp('completed_at'),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'agent_runs_session_owner_fk',
      columns: [table.sessionId, table.ownerId],
      foreignColumns: [sessions.id, sessions.ownerId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_runs_hand_scope_fk',
      columns: [table.handId, table.ownerId, table.sessionId],
      foreignColumns: [hands.id, hands.ownerId, hands.sessionId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_runs_participant_scope_fk',
      columns: [table.participantId, table.sessionId, table.ownerId],
      foreignColumns: [
        sessionAgents.participantId,
        sessionAgents.sessionId,
        sessionAgents.ownerId,
      ],
    }).onDelete('cascade'),
    unique('agent_runs_session_runtime_idempotency_unique').on(
      table.sessionId,
      table.runtime,
      table.idempotencyKey,
    ),
    unique('agent_runs_session_request_unique').on(
      table.sessionId,
      table.decisionRequestId,
    ),
    unique('agent_runs_id_session_owner_request_unique').on(
      table.id,
      table.sessionId,
      table.ownerId,
      table.decisionRequestId,
    ),
    unique('agent_runs_id_owner_session_unique').on(
      table.id,
      table.ownerId,
      table.sessionId,
    ),
    unique('agent_runs_player_decision_identity_unique').on(
      table.id,
      table.ownerId,
      table.sessionId,
      table.handId,
      table.participantId,
      table.sourceStateVersion,
      table.decisionRequestId,
      table.runtime,
    ),
    uniqueIndex('agent_runs_one_active_player_decision')
      .on(table.sessionId, table.sourceStateVersion, table.participantId)
      .where(
        sql`${table.runtime} = 'player'
          AND ${table.lifecycle} IN ('queued', 'leased', 'running')`,
      ),
    index('agent_runs_worker_claim_idx').on(
      table.runtime,
      table.lifecycle,
      table.leaseExpiresAt,
      table.deadlineAt,
      table.createdAt,
      table.id,
    ),
    index('agent_runs_runtime_concurrency_idx')
      .on(table.runtime, table.lifecycle, table.ownerId, table.leaseExpiresAt)
      .where(sql`${table.lifecycle} IN ('leased', 'running')`),
    index('agent_runs_session_created_idx').on(
      table.sessionId,
      table.createdAt,
    ),
    index('agent_runs_hand_runtime_idx').on(table.handId, table.runtime),
    index('agent_runs_participant_created_idx').on(
      table.participantId,
      table.createdAt,
    ),
    check(
      'agent_runs_runtime_check',
      sql`${table.runtime} IN ('player', 'coach')`,
    ),
    check(
      'agent_runs_lifecycle_check',
      sql`${table.lifecycle} IN (
        'queued', 'leased', 'running', 'completed', 'failed', 'cancelled', 'stale'
      )`,
    ),
    check(
      'agent_runs_idempotency_key_not_blank',
      sql`length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check(
      'agent_runs_runtime_fields_check',
      sql`(
        ${table.runtime} = 'player'
        AND ${table.participantId} IS NOT NULL
        AND ${table.sourceStateVersion} IS NOT NULL
        AND ${table.decisionRequestId} IS NOT NULL
      ) OR (
        ${table.runtime} = 'coach'
        AND ${table.participantId} IS NULL
        AND ${table.sourceStateVersion} IS NULL
        AND ${table.decisionRequestId} IS NULL
      )`,
    ),
    check(
      'agent_runs_safe_values_check',
      sql`${table.fencingToken} BETWEEN 0 AND 9007199254740991
        AND (
          ${table.sourceStateVersion} IS NULL
          OR ${table.sourceStateVersion} BETWEEN 0 AND 9007199254740991
        )`,
    ),
    check(
      'agent_runs_runtime_definition_version_positive',
      sql`${table.runtimeDefinitionVersion} > 0`,
    ),
    check(
      'agent_runs_lease_pair_check',
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)
        OR (
          ${table.leaseOwner} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
          AND
          length(btrim(${table.leaseOwner})) > 0
        )`,
    ),
    check(
      'agent_runs_lifecycle_fields_check',
      sql`(
        ${table.lifecycle} = 'queued'
        AND ${table.leaseOwner} IS NULL
        AND ${table.startedAt} IS NULL
        AND ${table.completedAt} IS NULL
        AND ${table.terminationReason} IS NULL
      ) OR (
        ${table.lifecycle} = 'leased'
        AND ${table.leaseOwner} IS NOT NULL
        AND ${table.completedAt} IS NULL
        AND ${table.terminationReason} IS NULL
      ) OR (
        ${table.lifecycle} = 'running'
        AND ${table.leaseOwner} IS NOT NULL
        AND ${table.startedAt} IS NOT NULL
        AND ${table.completedAt} IS NULL
        AND ${table.terminationReason} IS NULL
      ) OR (
        ${table.lifecycle} = 'completed'
        AND ${table.leaseOwner} IS NULL
        AND ${table.startedAt} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.terminationReason} IS NULL
      ) OR (
        ${table.lifecycle} = 'failed'
        AND ${table.leaseOwner} IS NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.terminationReason} IS NOT NULL
      ) OR (
        ${table.lifecycle} IN ('cancelled', 'stale')
        AND ${table.leaseOwner} IS NULL
        AND ${table.completedAt} IS NOT NULL
        AND ${table.terminationReason} IS NOT NULL
      )`,
    ),
    check(
      'agent_runs_timestamp_order_check',
      sql`${table.deadlineAt} >= ${table.createdAt}
        AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
        AND (
          ${table.startedAt} IS NULL
          OR ${table.completedAt} IS NULL
          OR ${table.completedAt} >= ${table.startedAt}
        )
        AND (
          ${table.leaseExpiresAt} IS NULL
          OR ${table.leaseExpiresAt} > ${table.updatedAt}
        )`,
    ),
    check(
      'agent_runs_required_payloads_check',
      sql`${table.runConfigPayloadVersion} > 0
        AND jsonb_typeof(${table.runConfigPayload}) = 'object'
        AND ${table.budgetPayloadVersion} > 0
        AND jsonb_typeof(${table.budgetPayload}) = 'object'`,
    ),
  ],
)

export const agentAttempts = appPrivateSchema.table(
  'agent_attempts',
  {
    id: uuid('id').primaryKey(),
    agentRunId: uuid('agent_run_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    fencingToken: safeBigint('fencing_token').notNull(),
    stage: text('stage').notNull(),
    lifecycle: text('lifecycle').notNull(),
    accepted: boolean('accepted').notNull().default(false),
    stale: boolean('stale').notNull().default(false),
    interrupted: boolean('interrupted').notNull().default(false),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    attemptType: text('attempt_type').notNull(),
    routingReason: text('routing_reason'),
    inputTokens: safeBigint('input_tokens').notNull().default(0),
    outputTokens: safeBigint('output_tokens').notNull().default(0),
    costMicrounits: safeBigint('cost_microunits').notNull().default(0),
    durationMs: safeBigint('duration_ms'),
    errorCategory: text('error_category'),
    attemptPayloadVersion: integer('attempt_payload_version'),
    attemptPayload: objectPayload('attempt_payload'),
    startedAt: zonedTimestamp('started_at').notNull(),
    completedAt: zonedTimestamp('completed_at'),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'agent_attempts_run_scope_fk',
      columns: [table.agentRunId, table.ownerId, table.sessionId],
      foreignColumns: [agentRuns.id, agentRuns.ownerId, agentRuns.sessionId],
    }).onDelete('cascade'),
    unique('agent_attempts_run_number_unique').on(
      table.agentRunId,
      table.attemptNumber,
    ),
    unique('agent_attempts_id_run_owner_session_unique').on(
      table.id,
      table.agentRunId,
      table.ownerId,
      table.sessionId,
    ),
    index('agent_attempts_session_created_idx').on(
      table.sessionId,
      table.createdAt,
    ),
    check(
      'agent_attempts_attempt_number_check',
      sql`${table.attemptNumber} >= 0
        AND ${table.fencingToken} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      'agent_attempts_lifecycle_check',
      sql`${table.lifecycle} IN ('started', 'completed', 'failed', 'cancelled', 'stale')`,
    ),
    check(
      'agent_attempts_safe_values_check',
      sql`${table.inputTokens} BETWEEN 0 AND 9007199254740991
        AND ${table.outputTokens} BETWEEN 0 AND 9007199254740991
        AND ${table.costMicrounits} BETWEEN 0 AND 9007199254740991
        AND (
          ${table.durationMs} IS NULL
          OR ${table.durationMs} BETWEEN 0 AND 9007199254740991
        )`,
    ),
    check(
      'agent_attempts_payload_check',
      sql`(
        ${table.attemptPayloadVersion} IS NULL
        AND ${table.attemptPayload} IS NULL
      ) OR (
        ${table.attemptPayloadVersion} IS NOT NULL
        AND ${table.attemptPayload} IS NOT NULL
        AND ${table.attemptPayloadVersion} > 0
        AND jsonb_typeof(${table.attemptPayload}) = 'object'
      )`,
    ),
  ],
)

export const playerDecisions = appPrivateSchema.table(
  'player_decisions',
  {
    id: uuid('id').primaryKey(),
    agentRunId: uuid('agent_run_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    handId: uuid('hand_id').notNull(),
    participantId: uuid('participant_id').notNull(),
    sourceStateVersion: safeBigint('source_state_version').notNull(),
    decisionRequestId: uuid('decision_request_id').notNull(),
    runtime: text('runtime').notNull(),
    recordVersion: integer('record_version').notNull(),
    status: text('status').notNull(),
    decisionAuditSnapshotPayloadVersion: integer(
      'decision_audit_snapshot_payload_version',
    ).notNull(),
    decisionAuditSnapshotPayload: objectPayload(
      'decision_audit_snapshot_payload',
    ).notNull(),
    candidateSetPayloadVersion: integer(
      'candidate_set_payload_version',
    ).notNull(),
    candidateSetPayload: objectPayload('candidate_set_payload').notNull(),
    modelProjectionPayloadVersion: integer('model_projection_payload_version'),
    modelProjectionPayload: objectPayload('model_projection_payload'),
    modelChoicePayloadVersion: integer('model_choice_payload_version'),
    modelChoicePayload: objectPayload('model_choice_payload'),
    validatorResultPayloadVersion: integer('validator_result_payload_version'),
    validatorResultPayload: objectPayload('validator_result_payload'),
    acceptedAttemptId: uuid('accepted_attempt_id'),
    commandLedgerId: uuid('command_ledger_id'),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
    modelPreparedAt: zonedTimestamp('model_prepared_at'),
    selectedAt: zonedTimestamp('selected_at'),
    committedAt: zonedTimestamp('committed_at'),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'player_decisions_run_identity_fk',
      columns: [
        table.agentRunId,
        table.ownerId,
        table.sessionId,
        table.handId,
        table.participantId,
        table.sourceStateVersion,
        table.decisionRequestId,
        table.runtime,
      ],
      foreignColumns: [
        agentRuns.id,
        agentRuns.ownerId,
        agentRuns.sessionId,
        agentRuns.handId,
        agentRuns.participantId,
        agentRuns.sourceStateVersion,
        agentRuns.decisionRequestId,
        agentRuns.runtime,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'player_decisions_participant_scope_fk',
      columns: [table.participantId, table.sessionId, table.ownerId],
      foreignColumns: [
        sessionAgents.participantId,
        sessionAgents.sessionId,
        sessionAgents.ownerId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'player_decisions_accepted_attempt_scope_fk',
      columns: [
        table.acceptedAttemptId,
        table.agentRunId,
        table.ownerId,
        table.sessionId,
      ],
      foreignColumns: [
        agentAttempts.id,
        agentAttempts.agentRunId,
        agentAttempts.ownerId,
        agentAttempts.sessionId,
      ],
    }),
    foreignKey({
      name: 'player_decisions_command_ledger_scope_fk',
      columns: [table.commandLedgerId, table.sessionId, table.ownerId],
      foreignColumns: [
        commandLedger.id,
        commandLedger.sessionId,
        commandLedger.ownerId,
      ],
    }),
    unique('player_decisions_agent_run_unique').on(table.agentRunId),
    unique('player_decisions_command_ledger_unique').on(table.commandLedgerId),
    index('player_decisions_session_status_idx').on(
      table.sessionId,
      table.status,
      table.updatedAt,
    ),
    check(
      'player_decisions_identity_check',
      sql`${table.runtime} = 'player'
        AND ${table.recordVersion} = 1
        AND ${table.sourceStateVersion} BETWEEN 0 AND 9007199254740991`,
    ),
    check(
      'player_decisions_status_check',
      sql`${table.status} IN ('auditPrepared', 'modelPrepared', 'selected', 'committed')`,
    ),
    check(
      'player_decisions_required_payloads_check',
      sql`${table.decisionAuditSnapshotPayloadVersion} > 0
        AND jsonb_typeof(${table.decisionAuditSnapshotPayload}) = 'object'
        AND ${table.candidateSetPayloadVersion} > 0
        AND jsonb_typeof(${table.candidateSetPayload}) = 'object'`,
    ),
    check(
      'player_decisions_optional_payload_pairs_check',
      sql`((
        ${table.modelProjectionPayloadVersion} IS NULL
        AND ${table.modelProjectionPayload} IS NULL
      ) OR (
        ${table.modelProjectionPayloadVersion} IS NOT NULL
        AND ${table.modelProjectionPayloadVersion} > 0
        AND ${table.modelProjectionPayload} IS NOT NULL
        AND jsonb_typeof(${table.modelProjectionPayload}) = 'object'
      ))
        AND (
          (
          ${table.modelChoicePayloadVersion} IS NULL
          AND ${table.modelChoicePayload} IS NULL
          ) OR (
          ${table.modelChoicePayloadVersion} IS NOT NULL
          AND ${table.modelChoicePayloadVersion} > 0
          AND ${table.modelChoicePayload} IS NOT NULL
          AND jsonb_typeof(${table.modelChoicePayload}) = 'object'
          )
        )
        AND (
          (
          ${table.validatorResultPayloadVersion} IS NULL
          AND ${table.validatorResultPayload} IS NULL
          ) OR (
          ${table.validatorResultPayloadVersion} IS NOT NULL
          AND ${table.validatorResultPayloadVersion} > 0
          AND ${table.validatorResultPayload} IS NOT NULL
          AND jsonb_typeof(${table.validatorResultPayload}) = 'object'
          )
        )`,
    ),
    check(
      'player_decisions_stage_matrix_check',
      sql`(
        ${table.status} = 'auditPrepared'
        AND ${table.modelProjectionPayloadVersion} IS NULL
        AND ${table.modelChoicePayloadVersion} IS NULL
        AND ${table.validatorResultPayloadVersion} IS NULL
        AND ${table.acceptedAttemptId} IS NULL
        AND ${table.modelPreparedAt} IS NULL
        AND ${table.selectedAt} IS NULL
        AND ${table.commandLedgerId} IS NULL
        AND ${table.committedAt} IS NULL
      ) OR (
        ${table.status} = 'modelPrepared'
        AND ${table.modelProjectionPayloadVersion} IS NOT NULL
        AND ${table.modelChoicePayloadVersion} IS NULL
        AND ${table.validatorResultPayloadVersion} IS NULL
        AND ${table.acceptedAttemptId} IS NULL
        AND ${table.modelPreparedAt} IS NOT NULL
        AND ${table.selectedAt} IS NULL
        AND ${table.commandLedgerId} IS NULL
        AND ${table.committedAt} IS NULL
      ) OR (
        ${table.status} = 'selected'
        AND ${table.modelProjectionPayloadVersion} IS NOT NULL
        AND ${table.modelChoicePayloadVersion} IS NOT NULL
        AND ${table.validatorResultPayloadVersion} IS NOT NULL
        AND ${table.acceptedAttemptId} IS NOT NULL
        AND ${table.modelPreparedAt} IS NOT NULL
        AND ${table.selectedAt} IS NOT NULL
        AND ${table.commandLedgerId} IS NULL
        AND ${table.committedAt} IS NULL
      ) OR (
        ${table.status} = 'committed'
        AND ${table.modelProjectionPayloadVersion} IS NOT NULL
        AND ${table.modelChoicePayloadVersion} IS NOT NULL
        AND ${table.validatorResultPayloadVersion} IS NOT NULL
        AND ${table.acceptedAttemptId} IS NOT NULL
        AND ${table.modelPreparedAt} IS NOT NULL
        AND ${table.selectedAt} IS NOT NULL
        AND ${table.commandLedgerId} IS NOT NULL
        AND ${table.committedAt} IS NOT NULL
      )`,
    ),
    check(
      'player_decisions_timestamp_order_check',
      sql`(${table.modelPreparedAt} IS NULL OR ${table.modelPreparedAt} >= ${table.createdAt})
        AND (${table.selectedAt} IS NULL OR ${table.selectedAt} >= ${table.createdAt})
        AND (
          ${table.modelPreparedAt} IS NULL
          OR ${table.selectedAt} IS NULL
          OR ${table.selectedAt} >= ${table.modelPreparedAt}
        )
        AND (
          ${table.committedAt} IS NULL
          OR (${table.selectedAt} IS NOT NULL AND ${table.committedAt} >= ${table.selectedAt})
        )`,
    ),
  ],
)

export const agentCapabilityInvocations = appPrivateSchema.table(
  'agent_capability_invocations',
  {
    id: uuid('id').primaryKey(),
    agentRunId: uuid('agent_run_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    invocationNumber: integer('invocation_number').notNull(),
    fencingToken: safeBigint('fencing_token').notNull(),
    capabilityName: text('capability_name').notNull(),
    capabilityVersion: integer('capability_version').notNull(),
    authorized: boolean('authorized').notNull(),
    inputSchemaVersion: integer('input_schema_version').notNull(),
    inputHash: text('input_hash').notNull(),
    outputSchemaVersion: integer('output_schema_version'),
    outputHash: text('output_hash'),
    budgetCost: safeBigint('budget_cost').notNull().default(0),
    durationMs: safeBigint('duration_ms'),
    errorCategory: text('error_category'),
    startedAt: zonedTimestamp('started_at').notNull(),
    completedAt: zonedTimestamp('completed_at'),
    createdAt: zonedTimestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'agent_capability_invocations_run_scope_fk',
      columns: [table.agentRunId, table.ownerId, table.sessionId],
      foreignColumns: [agentRuns.id, agentRuns.ownerId, agentRuns.sessionId],
    }).onDelete('cascade'),
    unique('agent_capability_invocations_run_number_unique').on(
      table.agentRunId,
      table.invocationNumber,
    ),
    index('agent_capability_invocations_capability_idx').on(
      table.capabilityName,
      table.capabilityVersion,
      table.createdAt,
    ),
    check(
      'agent_capability_invocations_number_check',
      sql`${table.invocationNumber} >= 0
        AND ${table.fencingToken} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      'agent_capability_invocations_schema_versions_check',
      sql`${table.capabilityVersion} > 0
        AND ${table.inputSchemaVersion} > 0
        AND (
          (
            ${table.outputSchemaVersion} IS NULL
            AND ${table.outputHash} IS NULL
          ) OR (
            ${table.outputSchemaVersion} IS NOT NULL
            AND ${table.outputHash} IS NOT NULL
            AND ${table.outputSchemaVersion} > 0
            AND ${table.outputHash} ~ '^[0-9a-f]{64}$'
          )
        )`,
    ),
    check(
      'agent_capability_invocations_input_hash_check',
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'agent_capability_invocations_safe_values_check',
      sql`${table.budgetCost} BETWEEN 0 AND 9007199254740991
        AND (
          ${table.durationMs} IS NULL
          OR ${table.durationMs} BETWEEN 0 AND 9007199254740991
        )`,
    ),
  ],
)

export const appSettings = appPrivateSchema.table(
  'app_settings',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'cascade' }),
    settingKey: text('setting_key').notNull(),
    settingPayload: objectPayload('setting_payload').notNull(),
    updatedAt: zonedTimestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('app_settings_owner_key_unique').on(table.ownerId, table.settingKey),
    check(
      'app_settings_key_not_blank',
      sql`length(btrim(${table.settingKey})) > 0`,
    ),
    check(
      'app_settings_payload_check',
      sql`jsonb_typeof(${table.settingPayload}) = 'object'`,
    ),
  ],
)
