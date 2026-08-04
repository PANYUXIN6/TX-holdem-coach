import { z } from 'zod'

export const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

export const NonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

export const CanonicalAuditReferenceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9._:/@-]*[a-z0-9])?$/)

export type CanonicalAuditReferenceId = z.infer<
  typeof CanonicalAuditReferenceIdSchema
>

export const StableAuditCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)

export type StableAuditCode = z.infer<typeof StableAuditCodeSchema>

export const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>

export const AuditVersionReferenceSchema = z.strictObject({
  id: CanonicalAuditReferenceIdSchema,
  version: PositiveSafeIntegerSchema,
})

export type AuditVersionReference = Readonly<
  z.infer<typeof AuditVersionReferenceSchema>
>
