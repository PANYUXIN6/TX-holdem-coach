export const PLAYER_MODEL_INPUT_LIMITS = Object.freeze({
  maximumContextBytes: 30_000,
  maximumWorstCaseInitialRequestBytes: 33_000,
  maximumRequestBytes: 35_000,
  maximumRunInputTokens: 12_000,
} as const)
