/** One database row as column name to value. */
export type Row = Record<string, unknown>

/** What the database reports after running a statement. */
export type RunResult =
  { changes: number
  , lastInsertRowid: number
  }

/** The database operations the server needs: queries, statements and transactions. */
export type RowDatabase = {
  /** Run a query and return every row. */
  all: (sql: string, params?: unknown[]) => Promise<Row[]>
  /** Run a query and return the first row, if any. */
  get: (sql: string, params?: unknown[]) => Promise<Row | undefined>
  /** Run a statement and report what it changed. */
  run: (sql: string, params?: unknown[]) => Promise<RunResult>
  /** Run the function inside a transaction when the database supports them. */
  transaction?:
    <T>(fn: (db: RowDatabase) => Promise<T>) => Promise<T>
}

/** A prepared statement of the embedded database driver. */
export type SqlStatement = {
  /** Run the statement and return every row. */
  all: (...params: unknown[]) => Promise<Row[]>
  /** Run the statement and return the first row, if any. */
  get: (...params: unknown[]) => Promise<Row | undefined>
  /** Run the statement and report what it changed. */
  run: (...params: unknown[]) => Promise<RunResult>
}

/** The driver's `transactionAsync`: wraps a function so that calling it runs it in a transaction. */
export type SqlTransactionFactory =
  (fn: (transaction: SqlConnection) => Promise<unknown>) =>
    (...args: unknown[]) => Promise<unknown>

/** What the server needs of an embedded database connection, such as the one `openDatabase` returns. */
export type SqlConnection = {
  /** Prepare a statement. */
  prepare: (sql: string) => Promise<SqlStatement>
  /** Run work in a transaction, when the driver supports it. */
  transactionAsync?: SqlTransactionFactory
}

export const createRowDatabase =
  (connection: SqlConnection): RowDatabase => {
    const database: RowDatabase =
      { all: async (sql, params = []) => {
          const statement = await connection.prepare(sql)
          return await statement.all(...params)
        }
      , get: async (sql, params = []) => {
          const statement = await connection.prepare(sql)
          return await statement.get(...params)
        }
      , run: async (sql, params = []) => {
          const statement = await connection.prepare(sql)
          return await statement.run(...params)
        }
      }

    if (connection.transactionAsync) {
      database.transaction =
        async <T>(fn: (db: RowDatabase) => Promise<T>): Promise<T> => {
          const wrapped =
            connection.transactionAsync!(
              async transaction =>
                await fn(createRowDatabase(transaction)))
          return await wrapped() as T
        }
    }

    return database
  }
