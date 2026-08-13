import {
  CommandRequestSchema,
  CommandResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  PROTOCOL_VERSION,
  SessionPathParamsSchema,
  SessionSnapshotResponseSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import type { SessionCommandExecutor } from '../sessions/command-execution/session-command-executor.js'
import type { SessionCreationService } from '../sessions/session-creation/session-creation-service.js'
import type { ApiHono } from './api-context.js'
import { statusForStableErrorCode } from './error-mapper.js'
import {
  HttpBoundaryError,
  parseInput,
  parseJsonBody,
} from './request-boundary.js'
import { jsonResponse } from './response.js'

export interface PublicSessionQueryService {
  findActive(): Promise<PublicSessionSnapshot | null>
  getById(sessionId: string): Promise<PublicSessionSnapshot | null>
}

export interface SessionHttpPorts {
  readonly creation: SessionCreationService
  readonly query: PublicSessionQueryService
  readonly commands: SessionCommandExecutor
}

function sessionNotFound(): HttpBoundaryError {
  return new HttpBoundaryError(404, 'SESSION_NOT_FOUND', '场次不存在。')
}

export function registerSessionRoutes(
  app: ApiHono,
  ports: SessionHttpPorts,
): void {
  app.post('/api/sessions', async (context) => {
    const request = await parseJsonBody(context, CreateSessionRequestSchema)
    const result = await ports.creation.create(request)
    if (result.kind === 'created') {
      return jsonResponse(
        context,
        CreateSessionResponseSchema,
        result.response,
        201,
      )
    }
    return jsonResponse(context, ErrorResponseSchema, result.response, 409)
  })

  app.get('/api/sessions/active', async (context) => {
    const snapshot = await ports.query.findActive()
    if (snapshot === null) throw sessionNotFound()
    return jsonResponse(context, SessionSnapshotResponseSchema, {
      protocolVersion: PROTOCOL_VERSION,
      snapshot,
    })
  })

  app.get('/api/sessions/:sessionId', async (context) => {
    const { sessionId } = parseInput(
      SessionPathParamsSchema,
      context.req.param(),
    )
    const snapshot = await ports.query.getById(sessionId)
    if (snapshot === null) throw sessionNotFound()
    return jsonResponse(context, SessionSnapshotResponseSchema, {
      protocolVersion: PROTOCOL_VERSION,
      snapshot,
    })
  })

  app.post('/api/sessions/:sessionId/commands', async (context) => {
    const { sessionId } = parseInput(
      SessionPathParamsSchema,
      context.req.param(),
    )
    const request = await parseJsonBody(context, CommandRequestSchema)
    if (sessionId !== request.command.sessionId) {
      throw new HttpBoundaryError(
        400,
        'INVALID_REQUEST',
        '路径场次与命令场次不一致。',
        [
          {
            path: ['command', 'sessionId'],
            message: '必须与路径 sessionId 一致。',
          },
        ],
      )
    }
    const result = await ports.commands.execute(request.command)
    if (result.kind === 'completed') {
      return jsonResponse(context, CommandResponseSchema, result.response)
    }
    if (result.kind === 'rejected') {
      return jsonResponse(
        context,
        ErrorResponseSchema,
        result.response,
        statusForStableErrorCode(result.response.code),
      )
    }
    context.header('Retry-After', '1')
    return jsonResponse(
      context,
      ErrorResponseSchema,
      {
        protocolVersion: PROTOCOL_VERSION,
        code: 'COMMAND_PROCESSING',
        message: '命令正在处理中，请稍后重试。',
      },
      409,
    )
  })
}
