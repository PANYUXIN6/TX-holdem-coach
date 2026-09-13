import {
  LatestEndedRosterPreviewResponseSchema,
  type LatestEndedRosterPreviewResponse,
} from '@tx-holdem-coach/contracts'
import { readLatestEndedRosterPreview } from '../persistence/roster-preview-repository.js'
import { ActiveModelConfigurationSchema } from '../personas/config.js'
import {
  ActiveModelConfigurationError,
  ResourceNotFoundError,
} from '../persistence/errors.js'
import { assertRosterSnapshotsUseActiveModels } from './roster-preparation.js'
import {
  RosterSourceNotFoundServiceError,
  RosterModelInactiveServiceError,
} from './session-creation/session-creation-service.js'

export interface RosterPreviewService {
  read(): Promise<LatestEndedRosterPreviewResponse>
}
export function createRosterPreviewService(
  read: () => ReturnType<typeof readLatestEndedRosterPreview>,
): RosterPreviewService {
  return {
    async read() {
      try {
        const { session, snapshots } = await read()
        assertRosterSnapshotsUseActiveModels(
          snapshots,
          ActiveModelConfigurationSchema,
        )
        return LatestEndedRosterPreviewResponseSchema.parse({
          sourceSessionId: session.id,
          endedAt: session.endedAt,
          agents: snapshots.map((snapshot) => ({
            sourceSeatNumber: snapshot.seatNumber,
            configSnapshotKey: snapshot.configSnapshotKey,
            personaId: snapshot.personaId,
            personaVersion: snapshot.personaVersion,
            name: snapshot.displayName,
            avatarColor: snapshot.avatarColor,
            backgroundDescription: snapshot.configPayload.backgroundDescription,
            teachingSummary: snapshot.configPayload.teachingSummary,
            style: snapshot.configPayload.style,
          })),
        })
      } catch (error) {
        if (error instanceof ResourceNotFoundError)
          throw new RosterSourceNotFoundServiceError()
        if (error instanceof ActiveModelConfigurationError)
          throw new RosterModelInactiveServiceError(
            error.seatNumber,
            error.personaId,
          )
        throw error
      }
    },
  }
}
