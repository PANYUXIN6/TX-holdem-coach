import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import { createTransactionPublicProjectionReadPort } from '../../persistence/public-projection-repository.js'
import type { LockedActiveSessionForCreation } from '../../persistence/session-creation-repository.js'
import type {
  SnapshotProjectionInput,
  SnapshotProjectorBinding,
} from '../command-execution/snapshot-projector.js'
import type {
  ActiveSessionSnapshotReaderBinding,
  SessionCreationSnapshotProjectionInput,
  SessionCreationSnapshotProjectorBinding,
} from '../session-creation/session-creation-projector.js'
import type {
  ActivePublicProjectionReadPort,
  PublicProjectionReadPort,
} from './public-projection-facts.js'
import { PublicProjectionInvariantError } from './errors.js'
import { projectPublicSessionSnapshot } from './public-session-projector.js'

async function loadFacts(input: {
  readonly state: Parameters<typeof projectPublicSessionSnapshot>[0]['state']
  readonly session: Parameters<
    typeof projectPublicSessionSnapshot
  >[0]['session']
  readonly eventSeq: number
  readonly newPrivateEvents: Parameters<
    typeof projectPublicSessionSnapshot
  >[0]['newPrivateEvents']
  readonly reads: PublicProjectionReadPort
}) {
  const firstNewEventSeq = input.eventSeq - input.newPrivateEvents.length + 1
  const roster = await input.reads.readRoster(input.session.sessionId)
  const committedCurrentHandEvents =
    input.session.currentHandId === null
      ? []
      : await input.reads.readCurrentHandEvents({
          sessionId: input.session.sessionId,
          handId: input.session.currentHandId,
          beforeEventSeq:
            input.newPrivateEvents.length === 0
              ? input.eventSeq + 1
              : firstNewEventSeq,
        })
  return {
    state: input.state,
    session: input.session,
    eventSeq: input.eventSeq,
    newPrivateEvents: input.newPrivateEvents,
    roster,
    committedCurrentHandEvents,
  }
}

export function createPublicSessionBindings(owner: ResolvedOwnerScope): {
  readonly command: SnapshotProjectorBinding<PublicProjectionReadPort>
  readonly creation: SessionCreationSnapshotProjectorBinding<PublicProjectionReadPort>
  readonly activeReader: ActiveSessionSnapshotReaderBinding<ActivePublicProjectionReadPort>
} {
  const bindReadPort = (
    transaction: Parameters<
      typeof createTransactionPublicProjectionReadPort
    >[0],
  ) => createTransactionPublicProjectionReadPort(transaction, owner)
  const command: SnapshotProjectorBinding<PublicProjectionReadPort> =
    Object.freeze({
      projector: Object.freeze({
        async project(
          input: SnapshotProjectionInput<PublicProjectionReadPort>,
        ) {
          const { command: _command, ...factsInput } = input
          return projectPublicSessionSnapshot(await loadFacts(factsInput))
        },
      }),
      bindReadPort,
    })
  const creation: SessionCreationSnapshotProjectorBinding<PublicProjectionReadPort> =
    Object.freeze({
      projector: Object.freeze({
        async project(
          input: SessionCreationSnapshotProjectionInput<PublicProjectionReadPort>,
        ) {
          return projectPublicSessionSnapshot(await loadFacts(input))
        },
      }),
      bindReadPort,
    })
  const activeReader: ActiveSessionSnapshotReaderBinding<ActivePublicProjectionReadPort> =
    Object.freeze({
      reader: Object.freeze({
        async read(input: {
          readonly reference: LockedActiveSessionForCreation
          readonly reads: ActivePublicProjectionReadPort
        }) {
          const facts = await input.reads.readFacts(
            input.reference.session.sessionId,
          )
          if (
            facts === null ||
            facts.session.sessionId !== input.reference.session.sessionId ||
            facts.session.stateVersion !==
              input.reference.session.stateVersion ||
            facts.session.nextEventSeq !== input.reference.session.nextEventSeq
          ) {
            throw new PublicProjectionInvariantError()
          }
          return projectPublicSessionSnapshot(facts)
        },
      }),
      bindReadPort,
    })
  return Object.freeze({ command, creation, activeReader })
}
