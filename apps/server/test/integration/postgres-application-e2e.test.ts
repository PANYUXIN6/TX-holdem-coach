import { assertM32SessionCreation } from './database-m32-assertions.js'
import { assertM33PlayerActionHandCompletion } from './database-m33-assertions.js'
import { assertM34RebuyNextHandSessionEnd } from './database-m34-assertions.js'
import { assertM35SettingsHttpPostgresSmoke } from './postgres-e2e-m35-assertions.js'
import { assertM36PublicProjectionRuntime } from './database-m36-assertions.js'
import { assertM37SessionEventReplay } from './database-m37-assertions.js'
import { assertM42AgentRunLifecycle } from './database-m42-assertions.js'
import { assertM43ModelAttemptControl } from './database-m43-assertions.js'
import { assertM44PlayerObservationApplicationFlow } from './postgres-e2e-m44-assertions.js'
import { assertM45PlayerDecisionPreprocessingApplicationFlow } from './postgres-e2e-m45-assertions.js'
import { assertM46PlayerDecisionApplicationFlow } from './postgres-e2e-m46-assertions.js'
import { assertM47PlayerCommitApplicationFlow } from './postgres-e2e-m47-assertions.js'
import { assertM48PlayerCoordinationApplicationFlow } from './postgres-e2e-m48-assertions.js'
import { assertM49PlayerAuditReplayApplicationFlow } from './postgres-e2e-m49-assertions.js'
import { assertM410PlayerSessionIntegrationApplicationFlow } from './postgres-e2e-m410-assertions.js'
import { assertM52CompletedHandHistoryApplicationFlow } from './postgres-e2e-m52-assertions.js'
import { assertM53CompletedHandHistoryListApplicationFlow } from './postgres-e2e-m53-assertions.js'
import { assertM31SessionCommandExecutor } from './postgres-e2e-m31-assertions.js'
import {
  registerDatabaseMilestoneTest,
  registerPersistentDatabasePreparation,
} from './database-test-harness.js'

registerPersistentDatabasePreparation()

registerDatabaseMilestoneTest(
  'm31',
  'M3.1 session command executor',
  (sql, runtimeUrl) => assertM31SessionCommandExecutor(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm32',
  'M3.2 session creation and roster snapshot',
  (sql, runtimeUrl) => assertM32SessionCreation(sql, runtimeUrl),
  600_000,
)
registerDatabaseMilestoneTest(
  'm33',
  'M3.3 player action and hand completion',
  (sql, runtimeUrl) => assertM33PlayerActionHandCompletion(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm34',
  'M3.4 rebuy, next hand, and session end',
  (sql, runtimeUrl) => assertM34RebuyNextHandSessionEnd(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm35',
  'M3.5 settings HTTP PostgreSQL smoke',
  (sql) => assertM35SettingsHttpPostgresSmoke(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm36',
  'M3.6 public projection runtime',
  (sql, runtimeUrl) => assertM36PublicProjectionRuntime(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm37',
  'M3.7 SSE reconnection and event replay',
  (sql, runtimeUrl) => assertM37SessionEventReplay(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm42',
  'M4.2 AgentRun lifecycle, fencing, and claim scanning',
  (sql, runtimeUrl) => assertM42AgentRunLifecycle(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm43',
  'M4.3 ModelGateway Attempt budget control',
  (sql, runtimeUrl) => assertM43ModelAttemptControl(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm44',
  'M4.4 leased Player Run to certified observation',
  (sql) => assertM44PlayerObservationApplicationFlow(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm45',
  'M4.5 certified observation to deterministic decision preprocessing',
  (sql) => assertM45PlayerDecisionPreprocessingApplicationFlow(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm46',
  'M4.6 staged Player bounded-choice decision',
  (sql) => assertM46PlayerDecisionApplicationFlow(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm47',
  'M4.7 Player Validator and command Commit Gate',
  (sql, runtimeUrl) => assertM47PlayerCommitApplicationFlow(sql, runtimeUrl),
  900_000,
)
registerDatabaseMilestoneTest(
  'm48',
  'M4.8 Player pause and retry coordination',
  (sql) => assertM48PlayerCoordinationApplicationFlow(sql),
  900_000,
)
registerDatabaseMilestoneTest(
  'm49',
  'M4.9 Player Memory 与 Replay application flow',
  (sql) => assertM49PlayerAuditReplayApplicationFlow(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm410',
  'M4.10 Player Session integration application flow',
  (sql, runtimeUrl) =>
    assertM410PlayerSessionIntegrationApplicationFlow(sql, runtimeUrl),
  900_000,
)
registerDatabaseMilestoneTest(
  'm52',
  'M5.2 completed hand history application flow',
  (sql, runtimeUrl) =>
    assertM52CompletedHandHistoryApplicationFlow(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm53',
  'M5.3 completed hand history list application flow',
  (sql, runtimeUrl) =>
    assertM53CompletedHandHistoryListApplicationFlow(sql, runtimeUrl),
  300_000,
)
