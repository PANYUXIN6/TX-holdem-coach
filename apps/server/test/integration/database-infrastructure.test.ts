import { assertM22DatabaseSchema } from './database-schema-assertions.js'
import { assertM35AtomicPlayerSettingsPersistence } from './database-m35-assertions.js'
import { assertM44PlayerObservationPersistence } from './database-m44-assertions.js'
import {
  assertM24M25AtomicComposition,
  assertM23Repositories,
  assertM24CommandLedgerRepository,
  assertM25SessionMutationRepository,
  assertM26SessionRecoveryRepository,
  assertM27HandAgentAuditRepositories,
  assertM28ClearAndPreservedRoots,
  assertM28CoachDeletionContention,
  assertM28CurrentCatalogCreationContention,
  assertM28DeletionRollback,
  assertM28EndedDeletionAndCascade,
  assertM28HistoricalCandidateContention,
  assertM28HistoricalClearContention,
  assertM28PlayerDeletionContention,
  assertM28SingleDeletionLifecycleBoundary,
} from './database-repository-assertions.js'
import {
  registerDatabaseMilestoneTest,
  registerPersistentDatabasePreparation,
  registerStaleDatabaseTestCleanup,
} from './database-test-harness.js'

registerPersistentDatabasePreparation()

registerDatabaseMilestoneTest(
  'm22',
  'M2.2 schema',
  assertM22DatabaseSchema,
  300_000,
)
registerDatabaseMilestoneTest('m23', 'M2.3 repositories', (sql) =>
  assertM23Repositories(sql),
)
registerDatabaseMilestoneTest('m24', 'M2.4 command ledger', (sql, runtimeUrl) =>
  assertM24CommandLedgerRepository(sql, runtimeUrl),
)
registerDatabaseMilestoneTest(
  'm25',
  'M2.5 mutation and composition',
  async (sql, runtimeUrl) => {
    await assertM25SessionMutationRepository(sql, runtimeUrl)
    await assertM24M25AtomicComposition(sql)
  },
)
registerDatabaseMilestoneTest(
  'm26',
  'M2.6 recovery',
  (sql, runtimeUrl) => assertM26SessionRecoveryRepository(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm27',
  'M2.7 audit persistence',
  (sql, runtimeUrl) => assertM27HandAgentAuditRepositories(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 ended session deletion and cascade',
  (sql) => assertM28EndedDeletionAndCascade(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 single deletion lifecycle boundary',
  (sql) => assertM28SingleDeletionLifecycleBoundary(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 owner clear and preserved roots',
  (sql) => assertM28ClearAndPreservedRoots(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 deletion rollback',
  (sql) => assertM28DeletionRollback(sql),
  300_000,
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 Player deletion contention',
  (sql, runtimeUrl) => assertM28PlayerDeletionContention(sql, runtimeUrl),
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 Coach deletion contention',
  (sql, runtimeUrl) => assertM28CoachDeletionContention(sql, runtimeUrl),
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 current catalog creation contention',
  (sql, runtimeUrl) =>
    assertM28CurrentCatalogCreationContention(sql, runtimeUrl),
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 historical clear contention',
  (sql, runtimeUrl) => assertM28HistoricalClearContention(sql, runtimeUrl),
)
registerDatabaseMilestoneTest(
  'm28',
  'M2.8 historical candidate contention',
  (sql, runtimeUrl) => assertM28HistoricalCandidateContention(sql, runtimeUrl),
)
registerDatabaseMilestoneTest(
  'm35',
  'M3.5 atomic Player settings persistence',
  (sql, runtimeUrl) =>
    assertM35AtomicPlayerSettingsPersistence(sql, runtimeUrl),
  300_000,
)
registerDatabaseMilestoneTest(
  'm44',
  'M4.4 Player observation persistence and shared locks',
  (sql, runtimeUrl) => assertM44PlayerObservationPersistence(sql, runtimeUrl),
  300_000,
)

registerStaleDatabaseTestCleanup()
