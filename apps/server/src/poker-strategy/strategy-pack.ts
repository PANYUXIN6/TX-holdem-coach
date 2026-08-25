import { z } from 'zod'
import { M45AssumptionCodeSchema } from '../poker/decision-analysis-types.js'
import { POKER_RULE_SET_VERSION } from '../poker/poker-rule-set.js'

const SafePositiveIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const BasisPointsSchema = z.number().int().min(0).max(10_000)

export const StrategyDatasetIdSchema = z
  .string()
  .min(1)
  .max(114)
  .regex(/^[a-z0-9](?:[a-z0-9._:/@-]*[a-z0-9])?$/)

export const StrategyAssumptionCodeV1Schema = M45AssumptionCodeSchema
export const StrategyAbstractionLossCodeV1Schema = z.enum([
  'boardTextureCollapsed',
])

export type StrategyAssumptionCodeV1 = z.infer<
  typeof StrategyAssumptionCodeV1Schema
>
export type StrategyAbstractionLossCodeV1 = z.infer<
  typeof StrategyAbstractionLossCodeV1Schema
>

type StrategyCandidateSemantic =
  | { readonly actionType: 'fold' | 'check'; readonly target: null }
  | {
      readonly actionType: 'call' | 'bet' | 'raise' | 'allIn'
      readonly target: number
    }

function parseStrategyCandidateId(
  candidateId: string,
): StrategyCandidateSemantic | null {
  if (candidateId === 'fold' || candidateId === 'check') {
    return { actionType: candidateId, target: null }
  }
  const match = /^(call|bet|raise|allIn):([1-9]\d*)$/.exec(candidateId)
  if (match === null) return null
  const target = Number(match[2])
  if (!Number.isSafeInteger(target)) return null
  return {
    actionType: match[1] as 'call' | 'bet' | 'raise' | 'allIn',
    target,
  }
}

export const StrategyPackReferenceSchema = z.strictObject({
  datasetId: StrategyDatasetIdSchema,
  datasetVersion: SafePositiveIntegerSchema,
})

export const StrategyActionRecordSchema = z
  .strictObject({
    candidateId: z.string().trim().min(1),
    actionFrequencyBasisPoints: BasisPointsSchema,
    betSizePotRatio: z
      .strictObject({
        numerator: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        denominator: SafePositiveIntegerSchema,
      })
      .nullable(),
    solverEv: z
      .strictObject({
        valueMilliBigBlinds: z.number().int(),
        sourceRef: z.string().trim().min(1),
      })
      .nullable(),
  })
  .superRefine((action, context) => {
    const candidate = parseStrategyCandidateId(action.candidateId)
    if (candidate === null) {
      context.addIssue({
        code: 'custom',
        path: ['candidateId'],
        message: '策略候选 ID 必须使用规范合法动作语义。',
      })
      return
    }
    const alwaysSized =
      candidate.actionType === 'bet' || candidate.actionType === 'raise'
    const neverSized =
      candidate.actionType === 'fold' ||
      candidate.actionType === 'check' ||
      candidate.actionType === 'call'
    if (neverSized && action.betSizePotRatio !== null) {
      context.addIssue({
        code: 'custom',
        path: ['betSizePotRatio'],
        message: '非主动下注候选不得声明下注尺度。',
      })
      return
    }
    if (alwaysSized && action.betSizePotRatio === null) {
      context.addIssue({
        code: 'custom',
        path: ['betSizePotRatio'],
        message: '主动下注候选必须声明下注尺度。',
      })
      return
    }
    if (
      action.betSizePotRatio !== null &&
      action.betSizePotRatio?.numerator !== candidate.target
    ) {
      context.addIssue({
        code: 'custom',
        path: ['betSizePotRatio', 'numerator'],
        message: '下注尺度分子必须等于候选目标投入。',
      })
    }
  })

export const StrategyRecordSchema = z.strictObject({
  recordId: z.string().trim().min(1),
  matchKind: z.enum(['exact', 'referenceOnly']),
  spotKey: z.string().regex(/^[a-f0-9]{64}$/),
  handAbstractionKey: z.string().trim().min(1),
  assumptionCodes: z.array(StrategyAssumptionCodeV1Schema),
  abstractionLossCodes: z.array(StrategyAbstractionLossCodeV1Schema),
  sourceKind: z.enum(['solver', 'professionalReference', 'teachingReference']),
  sourceName: z.string().trim().min(1),
  sourceVersion: z.string().trim().min(1),
  licenseOrAuthorizationRef: z.string().trim().min(1),
  actions: z.array(StrategyActionRecordSchema).min(1),
})

export const StrategyPackSchema = z
  .strictObject({
    strategyPackSchemaVersion: z.literal(1),
    datasetId: StrategyDatasetIdSchema,
    datasetVersion: SafePositiveIntegerSchema,
    status: z.enum(['active', 'deprecated', 'revoked']),
    pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
    abstractionProfile: z.strictObject({
      profileId: z.string().trim().min(1),
      version: SafePositiveIntegerSchema,
      descriptionCode: z.string().trim().min(1),
    }),
    records: z.array(StrategyRecordSchema),
  })
  .superRefine((pack, context) => {
    const recordIds = new Set<string>()
    for (const [recordIndex, record] of pack.records.entries()) {
      if (recordIds.has(record.recordId)) {
        context.addIssue({
          code: 'custom',
          path: ['records', recordIndex, 'recordId'],
          message: '策略记录 ID 不得重复。',
        })
      }
      recordIds.add(record.recordId)
      if (
        new Set(record.assumptionCodes).size !== record.assumptionCodes.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['records', recordIndex, 'assumptionCodes'],
          message: '同一策略记录不得重复假设代码。',
        })
      }
      if (
        new Set(record.abstractionLossCodes).size !==
        record.abstractionLossCodes.length
      ) {
        context.addIssue({
          code: 'custom',
          path: ['records', recordIndex, 'abstractionLossCodes'],
          message: '同一策略记录不得重复抽象损失代码。',
        })
      }
      const candidateIds = new Set<string>()
      let totalWeight = 0
      for (const [actionIndex, action] of record.actions.entries()) {
        if (candidateIds.has(action.candidateId)) {
          context.addIssue({
            code: 'custom',
            path: [
              'records',
              recordIndex,
              'actions',
              actionIndex,
              'candidateId',
            ],
            message: '同一策略记录不得重复候选。',
          })
        }
        candidateIds.add(action.candidateId)
        totalWeight += action.actionFrequencyBasisPoints
      }
      if (totalWeight !== 10_000) {
        context.addIssue({
          code: 'custom',
          path: ['records', recordIndex, 'actions'],
          message: '策略记录候选权重必须精确闭合为 10000。',
        })
      }
      if (
        record.matchKind === 'exact' &&
        record.abstractionLossCodes.length > 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['records', recordIndex, 'abstractionLossCodes'],
          message: '精确策略记录不得声明抽象损失。',
        })
      }
      if (
        record.matchKind === 'referenceOnly' &&
        record.abstractionLossCodes.length === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['records', recordIndex, 'abstractionLossCodes'],
          message: '参考策略记录必须声明至少一项抽象损失。',
        })
      }
    }
  })

export type StrategyPackReference = z.infer<typeof StrategyPackReferenceSchema>
export type StrategyPack = z.infer<typeof StrategyPackSchema>

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function parseStrategyPack(input: unknown): StrategyPack {
  return deepFreeze(StrategyPackSchema.parse(input))
}
