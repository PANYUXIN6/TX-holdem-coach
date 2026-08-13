import type { PublicSessionQueryService } from '../../http/session-routes.js'
import type {
  PublicProjectionFactsLookup,
  PublicProjectionFactsRepository,
} from './public-projection-facts.js'
import { SessionReadonlyDiagnosticError } from './errors.js'
import { projectPublicSessionSnapshot } from './public-session-projector.js'

export function createPublicSessionQueryService(
  repository: PublicProjectionFactsRepository,
): PublicSessionQueryService {
  const project = (lookup: PublicProjectionFactsLookup) => {
    if (lookup === null) return null
    if ('kind' in lookup) {
      throw new SessionReadonlyDiagnosticError()
    }
    const facts = lookup
    if (facts.session.lifecycleStatus === 'readonlyDiagnostic') {
      throw new SessionReadonlyDiagnosticError()
    }
    return projectPublicSessionSnapshot(facts)
  }
  return Object.freeze({
    async findActive() {
      return project(await repository.findActive())
    },
    async getById(sessionId: string) {
      return project(await repository.getById(sessionId))
    },
  })
}
