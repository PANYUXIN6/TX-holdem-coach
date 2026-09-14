import { test } from 'vitest'
import { loadDatabaseTestMode } from '../../src/db/database-test-mode.js'
import { loadTestDatabaseConnections } from '../../src/db/test-database-safety.js'
import { assertDatabaseConnectionProtection } from './database-connection-assertions.js'
import {
  acquireDatabaseTestSuiteLock,
  createDatabaseTestSuiteLockClient,
  runAbortableDatabasePhase,
  runDatabaseTestWithCleanup,
  waitForDatabaseTestAbortCleanup,
} from './database-test-runtime.js'

test('verifies transaction pooler settings, idle expiry, and aborted cleanup', async (context) => {
  const mode = loadDatabaseTestMode(process.env)
  if (!mode.enabled || mode.runId === null) {
    context.skip()
    return
  }
  const { runtimeUrl, migrationUrl } = loadTestDatabaseConnections(process.env)
  const client = createDatabaseTestSuiteLockClient(migrationUrl, mode.runId)
  try {
    const lock = await acquireDatabaseTestSuiteLock(client)
    const signal = AbortSignal.any([context.signal, lock.signal])
    context.onTestFinished(
      () => waitForDatabaseTestAbortCleanup(signal),
      30_000,
    )
    await runDatabaseTestWithCleanup(
      () =>
        runAbortableDatabasePhase(
          'transaction pooler protection',
          signal,
          () => assertDatabaseConnectionProtection(runtimeUrl, signal),
          undefined,
          lock.signal,
        ),
      () => lock.release(),
    )
  } finally {
    await client.sql.end({ timeout: 0 })
  }
}, 60_000)
