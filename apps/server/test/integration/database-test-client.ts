import type { Sql, TransactionSql } from 'postgres'

interface TransactionSettingRow {
  readonly application_name?: string
  readonly statement_timeout?: string
  readonly idle_in_transaction_session_timeout?: string
}

async function initializeTransaction(
  transaction: TransactionSql,
  applicationName: string,
): Promise<void> {
  // SET/SHOW 不获取业务快照，调用方仍可随后设置 REPEATABLE READ。
  // 名称只由下面验证过的测试 Run ID/role 组成，不插入 URL 或业务输入。
  const results = await transaction
    .unsafe<TransactionSettingRow[][]>(
      `
    SET LOCAL application_name = '${applicationName}';
    SET LOCAL statement_timeout = '90s';
    SET LOCAL idle_in_transaction_session_timeout = '1min';
    SHOW application_name;
    SHOW statement_timeout;
    SHOW idle_in_transaction_session_timeout;
  `,
    )
    .simple()
  const rows = results.flat()
  if (
    rows.find((row) => row.application_name !== undefined)?.application_name !==
      applicationName ||
    rows.find((row) => row.statement_timeout !== undefined)
      ?.statement_timeout !== '90s' ||
    rows.find((row) => row.idle_in_transaction_session_timeout !== undefined)
      ?.idle_in_transaction_session_timeout !== '1min'
  ) {
    throw new Error('数据库测试事务配置未生效，已拒绝执行业务 SQL。')
  }
}

export function protectDatabaseTestTransactions(
  sql: Sql,
  applicationName: string,
  signal?: AbortSignal,
): Sql {
  if (!/^txhc-dbtest:[a-f0-9]{16}:[a-z0-9-]{1,24}$/.test(applicationName)) {
    throw new Error('数据库测试连接标签无效。')
  }
  const begin = sql.begin.bind(sql)
  type Callback = (transaction: TransactionSql) => unknown
  const protectedBegin = ((
    optionsOrCallback: string | Callback,
    callback?: Callback,
  ) => {
    signal?.throwIfAborted()
    const operation =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!
    const run = async (transaction: TransactionSql) => {
      signal?.throwIfAborted()
      await initializeTransaction(transaction, applicationName)
      signal?.throwIfAborted()
      let rejectAbort!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(signal?.reason)
        signal?.addEventListener('abort', rejectAbort, { once: true })
      })
      try {
        const result = operation(guardTransaction(transaction, signal))
        return await Promise.race([
          Array.isArray(result) ? Promise.all(result) : result,
          aborted,
        ])
      } finally {
        signal?.removeEventListener('abort', rejectAbort)
      }
    }
    return typeof optionsOrCallback === 'string'
      ? begin(optionsOrCallback, run)
      : begin(run)
  }) as Sql['begin']
  return new Proxy(sql, {
    apply(target, thisArgument, argumentsList) {
      signal?.throwIfAborted()
      return Reflect.apply(target, thisArgument, argumentsList)
    },
    get(target, property, receiver) {
      if (property === 'begin') return protectedBegin
      const value: unknown = Reflect.get(target, property, receiver)
      if (
        (property === 'unsafe' || property === 'file') &&
        typeof value === 'function'
      ) {
        return (...args: unknown[]) => {
          signal?.throwIfAborted()
          return Reflect.apply(value, target, args)
        }
      }
      return value
    },
  })
}

function guardTransaction(
  transaction: TransactionSql,
  signal?: AbortSignal,
): TransactionSql {
  if (signal === undefined) return transaction
  return new Proxy(transaction, {
    apply(target, thisArgument, argumentsList) {
      signal.throwIfAborted()
      return Reflect.apply(target, thisArgument, argumentsList)
    },
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'savepoint') {
        return (...args: unknown[]) => {
          signal.throwIfAborted()
          const callback = args.at(-1) as (tx: TransactionSql) => unknown
          return Reflect.apply(value, target, [
            ...args.slice(0, -1),
            (tx: TransactionSql) => callback(guardTransaction(tx, signal)),
          ])
        }
      }
      return (...args: unknown[]) => {
        signal.throwIfAborted()
        return Reflect.apply(value, target, args)
      }
    },
  })
}
