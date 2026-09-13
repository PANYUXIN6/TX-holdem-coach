import {
  CreateSessionRequestSchema,
  type CreateSessionRequest,
  type AgentPersonaId,
  type LatestEndedRosterPreviewBinding,
  type LatestEndedRosterPreviewResponse,
} from '@tx-holdem-coach/contracts'
export type Selection = {
  personaId: AgentPersonaId
  personaVersion: number
  seatNumber: number
}
export type SetupDraft = {
  selections: Selection[]
  preview: LatestEndedRosterPreviewBinding | null
  requiresAcceptance: boolean
  notice: string | null
}
export const initialDraft = (): SetupDraft => ({
  selections: [],
  preview: null,
  requiresAcceptance: false,
  notice: null,
})
export type SetupAction =
  | { type: 'select'; personaId: AgentPersonaId; personaVersion: number }
  | { type: 'remove'; personaId: AgentPersonaId }
  | { type: 'accept'; preview: LatestEndedRosterPreviewResponse }
  | { type: 'clearHistory' }
  | { type: 'reset' }
  | { type: 'seat'; source: SetupSource; from: number; to: number }
  | { type: 'shuffle'; source: SetupSource; seats: number[] }
  | { type: 'notice'; message?: string }
export function setupReducer(
  draft: SetupDraft,
  action: SetupAction,
): SetupDraft {
  switch (action.type) {
    case 'seat':
    case 'shuffle': {
      const rows =
        action.source === 'current'
          ? draft.selections
          : draft.preview?.assignments
      if (!rows) return draft
      const old = rows.map((p) => p.seatNumber)
      let seats: number[]
      if (action.type === 'seat') {
        if (
          !old.includes(action.from) ||
          !AI_SEATS.includes(action.to) ||
          action.from === action.to ||
          (action.source === 'latestEnded' && !old.includes(action.to))
        )
          return draft
        seats = old.map((n) =>
          n === action.from ? action.to : n === action.to ? action.from : n,
        )
      } else {
        if (!sameSeats(old, action.seats)) return draft
        seats = action.seats
      }
      return action.source === 'current'
        ? {
            ...draft,
            selections: draft.selections.map((p, i) => ({
              ...p,
              seatNumber: seats[i]!,
            })),
          }
        : {
            ...draft,
            preview: {
              ...draft.preview!,
              assignments: draft.preview!.assignments.map((p, i) => ({
                ...p,
                seatNumber: seats[i]!,
              })),
            },
          }
    }
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
                seatNumber: AI_SEATS.find(
                  (n) => !draft.selections.some((p) => p.seatNumber === n),
                )!,
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
      return { ...draft, notice: action.message ?? '请先确认阵容' }
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

export type SetupSource = 'current' | 'latestEnded'
export const AI_SEATS = [1, 2, 3, 4, 5, 6, 7, 8]
function sameSeats(a: number[], b: number[]) {
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    new Set(b).size === b.length &&
    a.every((n) => b.includes(n))
  )
}
export function seatsValid(draft: SetupDraft, source: SetupSource) {
  const rows =
    source === 'current' ? draft.selections : draft.preview?.assignments
  if (!rows || rows.length < 5 || rows.length > 8) return false
  const seats = rows.map((p) => p.seatNumber)
  return (
    seats.every((n) => AI_SEATS.includes(n)) &&
    new Set(seats).size === rows.length &&
    (source === 'current'
      ? new Set(draft.selections.map((p) => p.personaId)).size === rows.length
      : sameSeats(
          draft.preview!.assignments.map((p) => p.sourceSeatNumber),
          seats,
        ))
  )
}
export function shuffleSeats(input: number[], random = Math.random) {
  const seats = [...input]
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[seats[i], seats[j]] = [seats[j]!, seats[i]!]
  }
  return seats
}
export function createRequest(
  draft: SetupDraft,
  source: SetupSource,
  personas?: readonly { personaId: string; personaVersion: number }[],
  preview?: LatestEndedRosterPreviewResponse,
): CreateSessionRequest {
  if (
    !seatsValid(draft, source) ||
    !(source === 'current'
      ? catalogMatches(draft, personas)
      : previewMatches(draft.preview, preview))
  )
    throw new Error('阵容或座位已失效，请返回选择阵容重新确认')
  return CreateSessionRequestSchema.parse({
    rosterSource:
      source === 'current'
        ? {
            type: 'currentCatalog',
            selections: [...draft.selections]
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map(({ personaId, seatNumber }) => ({ personaId, seatNumber })),
          }
        : {
            type: 'latestEnded',
            preview: {
              ...draft.preview!,
              assignments: [...draft.preview!.assignments].sort(
                (a, b) => a.seatNumber - b.seatNumber,
              ),
            },
          },
  })
}
