/**
 * 只读取当前 Owner 下活动场次的稳定候选列表。恢复服务与 Player Dispatcher
 * 共同依赖这一中立查询边界，候选本身不承诺场次仍然存在。
 */
export interface ActiveSessionCandidateReader {
  listActiveSessionIds(): Promise<readonly string[]>
}
