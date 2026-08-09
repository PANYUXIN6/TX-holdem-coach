export interface PerSessionScheduler {
  run<Result>(sessionId: string, task: () => Promise<Result>): Promise<Result>
}

export function createPerSessionScheduler(): PerSessionScheduler {
  const tails = new Map<string, Promise<void>>()
  return Object.freeze({
    run<Result>(sessionId: string, task: () => Promise<Result>) {
      const key = sessionId.toLowerCase()
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(task)
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.finally(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
  })
}
