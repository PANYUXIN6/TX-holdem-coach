import type {
  AgentPersonaId,
  LatestEndedRosterPreviewBinding,
  LatestEndedRosterPreviewResponse,
} from '@tx-holdem-coach/contracts'
export type Selection = { personaId: AgentPersonaId; personaVersion: number }
export type SetupDraft = {
  selections: Selection[]
  preview: LatestEndedRosterPreviewBinding | null
  requiresAcceptance: boolean
  notice: boolean
}
export const initialDraft = (): SetupDraft => ({
  selections: [],
  preview: null,
  requiresAcceptance: false,
  notice: false,
})
export type SetupAction =
  | { type: 'select'; personaId: AgentPersonaId; personaVersion: number }
  | { type: 'remove'; personaId: AgentPersonaId }
  | { type: 'accept'; preview: LatestEndedRosterPreviewResponse }
  | { type: 'clearHistory' }
  | { type: 'reset' }
  | { type: 'notice' }
export function setupReducer(
  draft: SetupDraft,
  action: SetupAction,
): SetupDraft {
  switch (action.type) {
    case 'select':
      return draft.selections.length >= 8 ||
        draft.selections.some((p) => p.personaId === action.personaId)
        ? draft
        : {
            ...draft,
            selections: [
              ...draft.selections,
              {
                personaId: action.personaId,
                personaVersion: action.personaVersion,
              },
            ],
          }
    case 'remove':
      return {
        ...draft,
        selections: draft.selections.filter(
          (p) => p.personaId !== action.personaId,
        ),
      }
    case 'accept':
      return {
        ...draft,
        requiresAcceptance: false,
        preview: {
          sourceSessionId: action.preview.sourceSessionId,
          assignments: action.preview.agents.map((a) => ({
            sourceSeatNumber: a.sourceSeatNumber,
            seatNumber: a.sourceSeatNumber,
            configSnapshotKey: a.configSnapshotKey,
          })),
        },
      }
    case 'clearHistory':
      return { ...draft, preview: null, requiresAcceptance: true }
    case 'reset':
      return { ...initialDraft(), requiresAcceptance: true }
    case 'notice':
      return { ...draft, notice: true }
  }
}
export function catalogMatches(
  draft: SetupDraft,
  personas:
    readonly { personaId: string; personaVersion: number }[] | undefined,
) {
  return (
    draft.selections.length >= 5 &&
    draft.selections.length <= 8 &&
    draft.selections.every((s) =>
      personas?.some(
        (p) =>
          p.personaId === s.personaId && p.personaVersion === s.personaVersion,
      ),
    )
  )
}
export function previewMatches(
  binding: LatestEndedRosterPreviewBinding | null,
  preview: LatestEndedRosterPreviewResponse | undefined,
) {
  return (
    binding !== null &&
    preview !== undefined &&
    binding.sourceSessionId === preview.sourceSessionId &&
    binding.assignments.length === preview.agents.length &&
    binding.assignments.every((a) =>
      preview.agents.some(
        (p) =>
          p.sourceSeatNumber === a.sourceSeatNumber &&
          p.configSnapshotKey === a.configSnapshotKey,
      ),
    )
  )
}
export function readReady(query: {
  isSuccess: boolean
  fetchStatus: string
  isFetchedAfterMount: boolean
  isFetched: boolean
  wasResetSinceMount?: boolean
}) {
  return (
    query.isSuccess &&
    query.fetchStatus === 'idle' &&
    (query.isFetchedAfterMount ||
      (query.wasResetSinceMount === true && query.isFetched))
  )
}
