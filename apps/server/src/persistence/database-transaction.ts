import type { Sql, TransactionSql } from 'postgres'
import { DatabaseOperationError } from './errors.js'

class TransactionCallbackError extends Error {
  public constructor(public readonly original: unknown) {
    super('事务回调失败。')
    this.name = 'TransactionCallbackError'
  }
}

export async function runDatabaseTransaction<Value>(
  sql: Sql,
  operation: (transaction: TransactionSql) => Promise<Value>,
): Promise<Value> {
  try {
    return (await sql.begin(async (transaction) => {
      try {
        return await operation(transaction)
      } catch (error) {
        throw new TransactionCallbackError(error)
      }
    })) as Value
  } catch (error) {
    if (error instanceof TransactionCallbackError) throw error.original
    if (error instanceof DatabaseOperationError) throw error
    throw new DatabaseOperationError()
  }
}
