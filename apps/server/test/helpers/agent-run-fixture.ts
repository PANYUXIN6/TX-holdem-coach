import type { TransactionSql } from 'postgres'
import { encodeExecutionBudgetAudit } from '../../src/agents/audit/execution-budget-audit-codec.js'
import { encodeRunConfigurationAudit } from '../../src/agents/audit/run-configuration-audit-codec.js'
import type { ResolvedOwnerScope } from '../../src/persistence/owner-scope.js'

interface AgentRunFixtureBase {
  readonly agentRunId: string
  readonly sessionId: string
  readonly handId: string
  readonly triggerType: string
  readonly idempotencyKey: string
  readonly parentRunId: string | null
  readonly deadlineAt: string
  readonly runtimeDefinitionVersion: number
  readonly runConfiguration: unknown
  readonly budget: unknown
  readonly createdAt: string
}

export type AgentRunFixtureInput = AgentRunFixtureBase &
  (
    | {
        readonly runtime: 'player'
        readonly participantId: string
        readonly sourceStateVersion: number
        readonly decisionRequestId: string
      }
    | {
        readonly runtime: 'coach'
        readonly participantId: null
        readonly sourceStateVersion: null
        readonly decisionRequestId: null
      }
  )

export async function insertAgentRunFixture(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: AgentRunFixtureInput,
): Promise<void> {
  const configuration = encodeRunConfigurationAudit(input.runConfiguration)
  const budget = encodeExecutionBudgetAudit(input.budget)
  const configurationPayload = transaction.json(configuration.payload)
  const budgetPayload = transaction.json(budget.payload)

  await transaction`
    INSERT INTO app_private.agent_runs (
      id, owner_id, session_id, runtime, trigger_type, lifecycle,
      idempotency_key, hand_id, participant_id, source_state_version,
      decision_request_id, parent_run_id, replacement_run_id,
      lease_owner, lease_expires_at, fencing_token, deadline_at,
      runtime_definition_version, termination_reason,
      run_config_payload_version, run_config_payload,
      budget_payload_version, budget_payload,
      created_at, started_at, completed_at, updated_at
    ) VALUES (
      ${input.agentRunId}::uuid, ${owner.databaseOwnerId}::uuid,
      ${input.sessionId}::uuid, ${input.runtime}, ${input.triggerType},
      'queued', ${input.idempotencyKey}, ${input.handId}::uuid,
      ${input.participantId}::uuid, ${input.sourceStateVersion}::bigint,
      ${input.decisionRequestId}::uuid, ${input.parentRunId}::uuid, NULL,
      NULL, NULL, 0, ${input.deadlineAt}::timestamptz,
      ${input.runtimeDefinitionVersion}, NULL,
      ${configuration.payloadVersion}, ${configurationPayload},
      ${budget.payloadVersion}, ${budgetPayload},
      ${input.createdAt}::timestamptz,
      NULL, NULL, ${input.createdAt}::timestamptz
    )
  `
}
