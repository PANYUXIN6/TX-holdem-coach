export class TestDatabaseSafetyError extends Error {
  public constructor() {
    super('TEST_DATABASE_URL 必须指向隔离测试数据库。')
    this.name = 'TestDatabaseSafetyError'
  }
}

export function normalizeDatabaseAddress(value: string): string {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new TestDatabaseSafetyError()
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TestDatabaseSafetyError()
  }

  return [
    'postgresql:',
    url.hostname.toLowerCase(),
    url.port || '5432',
    decodeURIComponent(url.username),
    decodeURIComponent(url.pathname),
  ].join('|')
}

export function loadIsolatedTestDatabaseUrl(
  environment: NodeJS.ProcessEnv,
): string {
  const testDatabaseUrl = environment.TEST_DATABASE_URL

  if (testDatabaseUrl === undefined) {
    throw new TestDatabaseSafetyError()
  }

  const normalizedTestAddress = normalizeDatabaseAddress(testDatabaseUrl)

  for (const candidate of [
    environment.DATABASE_URL,
    environment.DATABASE_MIGRATION_URL,
  ]) {
    if (
      candidate !== undefined &&
      normalizeDatabaseAddress(candidate) === normalizedTestAddress
    ) {
      throw new TestDatabaseSafetyError()
    }
  }

  return testDatabaseUrl
}
