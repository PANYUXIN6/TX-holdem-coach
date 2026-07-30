export interface DatabaseTestMode {
  readonly enabled: boolean
  readonly full: boolean
}

export function loadDatabaseTestMode(
  environment: NodeJS.ProcessEnv,
): DatabaseTestMode {
  const enabled =
    environment.DATABASE_TEST_ENTRYPOINT === 'run-database-integration-tests'

  return {
    enabled,
    full: enabled && environment.DATABASE_TEST_SCOPE === 'full',
  }
}
