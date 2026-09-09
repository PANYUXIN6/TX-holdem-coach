import {
  ErrorResponseSchema,
  type ErrorResponse,
} from '@tx-holdem-coach/contracts'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  CommandPayloadConflictError,
  DatabaseOperationError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  SessionDeletionTransitionError,
} from '../persistence/errors.js'
import {
  DeepSeekNotConfiguredError,
  InvalidSessionCreationRequestError,
  RosterModelInactiveServiceError,
  RosterSourceChangedServiceError,
  RosterSourceNotFoundServiceError,
} from '../sessions/session-creation/session-creation-service.js'
import type { StableSessionCommandErrorCode } from '../sessions/command-execution/session-command-executor.js'
import { HttpBoundaryError } from './request-boundary.js'
import { HttpOutputValidationError } from './response.js'
import { SessionReadonlyDiagnosticError } from '../sessions/public-projection/errors.js'
import {
  AgentRunQueryNotFoundError,
  HandQueryNotFoundError,
} from '../agents/audit/query-errors.js'

export type StableSessionHttpErrorCode = StableSessionCommandErrorCode

const STABLE_SESSION_HTTP_STATUSES = {
  SESSION_NOT_FOUND: 404,
  STATE_VERSION_CONFLICT: 409,
  COMMAND_ID_CONFLICT: 409,
  COMMAND_NOT_ALLOWED_IN_PHASE: 409,
  PLAYER_NOT_CURRENT_ACTOR: 409,
  POKER_ACTION_NOT_LEGAL: 409,
  POKER_ACTION_TARGET_OUT_OF_RANGE: 409,
  REBUY_AMOUNT_NOT_ALLOWED: 409,
  USER_REBUY_REQUIRED: 409,
  AGENT_RETRY_NOT_ALLOWED: 409,
  SESSION_ENDED: 409,
  SESSION_READONLY_DIAGNOSTIC: 409,
} as const satisfies Record<StableSessionHttpErrorCode, ContentfulStatusCode>

export function statusForStableErrorCode(
  code: StableSessionHttpErrorCode,
): ContentfulStatusCode {
  return STABLE_SESSION_HTTP_STATUSES[code]
}

function errorResponse(value: ErrorResponse) {
  return ErrorResponseSchema.parse({
    ...value,
  })
}

export function mapHttpError(error: unknown): {
  readonly status: ContentfulStatusCode
  readonly response: ErrorResponse
} {
  if (error instanceof HttpBoundaryError) {
    return {
      status: error.status,
      response: errorResponse({
        code: error.code,
        message: error.message,
        ...(error.fieldErrors === undefined
          ? {}
          : {
              fieldErrors: error.fieldErrors.map((fieldError) => ({
                path: [...fieldError.path],
                message: fieldError.message,
              })),
            }),
      }),
    }
  }
  if (error instanceof ResourceNotFoundError) {
    return {
      status: 404,
      response: errorResponse({
        code: 'SESSION_NOT_FOUND',
        message: '场次不存在。',
      }),
    }
  }
  if (error instanceof HandQueryNotFoundError) {
    return {
      status: 404,
      response: errorResponse({
        code: 'HAND_NOT_FOUND',
        message: '手牌不存在。',
      }),
    }
  }
  if (error instanceof AgentRunQueryNotFoundError) {
    return {
      status: 404,
      response: errorResponse({
        code: 'AGENT_RUN_NOT_FOUND',
        message: 'Agent Run 不存在。',
      }),
    }
  }
  if (error instanceof SessionDeletionTransitionError) {
    return {
      status: 409,
      response: errorResponse({
        code: 'SESSION_NOT_ENDED',
        message: '只有已结束的场次可以单独删除。',
      }),
    }
  }
  if (error instanceof CommandPayloadConflictError) {
    return {
      status: 409,
      response: errorResponse({
        code: 'COMMAND_ID_CONFLICT',
        message: '命令标识已绑定到不同请求。',
      }),
    }
  }
  if (error instanceof SessionReadonlyDiagnosticError) {
    return {
      status: 409,
      response: errorResponse({ code: error.code, message: error.message }),
    }
  }
  if (
    error instanceof RepositoryInputValidationError ||
    error instanceof InvalidSessionCreationRequestError
  ) {
    return {
      status: 400,
      response: errorResponse({
        code: 'INVALID_REQUEST',
        message: '请求参数无效。',
      }),
    }
  }
  if (error instanceof RosterSourceNotFoundServiceError) {
    return {
      status: 404,
      response: errorResponse({ code: error.code, message: error.message }),
    }
  }
  if (
    error instanceof DeepSeekNotConfiguredError ||
    error instanceof RosterSourceChangedServiceError ||
    error instanceof RosterModelInactiveServiceError
  ) {
    return {
      status: 409,
      response: errorResponse({ code: error.code, message: error.message }),
    }
  }
  if (error instanceof DatabaseOperationError) {
    return {
      status: 503,
      response: errorResponse({
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂时不可用，请稍后重试。',
      }),
    }
  }
  if (error instanceof HttpOutputValidationError) {
    return {
      status: 500,
      response: errorResponse({
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务内部错误。',
      }),
    }
  }
  return {
    status: 500,
    response: errorResponse({
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务内部错误。',
    }),
  }
}

export function handleHttpError(error: unknown, context: Context): Response {
  const mapped = mapHttpError(error)
  return context.json(mapped.response, mapped.status)
}
