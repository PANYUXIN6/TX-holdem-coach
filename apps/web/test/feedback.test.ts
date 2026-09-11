import { expect, it } from 'vitest'
import { ApiError, errorMessage } from '../src/api/errors.js'

it('业务拒绝优先于通用输入错误，取消静默且未知错误不泄漏', () => {
  expect(
    errorMessage(new ApiError('input', undefined, 'SESSION_NOT_READY')),
  ).toContain('尚未就绪')
  expect(
    errorMessage(new ApiError('http', 409, 'SESSION_NOT_ENDED')),
  ).toContain('只能删除已结束')
  expect(errorMessage(new ApiError('http', 503))).toContain('服务暂不可用')
  expect(errorMessage(new ApiError('cancelled'))).toBeNull()
  expect(errorMessage(new Error('secret'))).not.toContain('secret')
})
