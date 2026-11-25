import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** One conformance case, as stored in `conformance/<suite>/<name>.json`. */
export type ConformanceCase =
  { description: string
  , operation: string
  , input: unknown
  , output?: unknown
  , error?: string
  }

/** An implementation of one conformance operation; it may return a promise. */
export type Operation = (input: never) => unknown

/** An error whose `code` a conformance case can expect. */
export class ConformanceError extends Error {
  /**
   * @param code - The stable error code the case names.
   * @param message - A human-readable detail.
   */
  constructor(readonly code: string, message = code) {
    super(message)
  }
}

/** The folder that holds every suite. */
export const CONFORMANCE_ROOT = join(import.meta.dir, '../../conformance')

/**
 * Load every case of one suite, sorted by file name.
 *
 * @param suite - The suite folder name, such as `protocol`.
 * @returns File name and case pairs.
 */
export const loadSuite =
  (suite: string): [string, ConformanceCase][] => {
    const dir = join(CONFORMANCE_ROOT, suite)
    const files: string[] = []
    const walk = (path: string) => {
      for (const name of readdirSync(path).sort()) {
        const full = join(path, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.json')) files.push(full)
      }
    }
    walk(dir)
    return files.map(file => [file.slice(dir.length + 1), JSON.parse(readFileSync(file, 'utf8')) as ConformanceCase])
  }

/**
 * Run one case against an implementation and describe any mismatch.
 *
 * @param operations - Implementations by operation name.
 * @param item - The case.
 * @returns `undefined` when the case passes, otherwise why it failed.
 */
export const runCase =
  async (operations: Record<string, Operation>, item: ConformanceCase): Promise<string | undefined> => {
    const operation = operations[item.operation]
    if (!operation) return `no implementation for operation "${item.operation}"`
    let result: unknown
    try {
      result = await operation(item.input as never)
    } catch (error) {
      if (item.error === undefined) return `unexpected error: ${String(error)}`
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined
      return code === item.error ? undefined : `expected error "${item.error}", got "${code ?? String(error)}"`
    }
    if (item.error !== undefined) return `expected error "${item.error}", got a result`
    const actual = JSON.stringify(result)
    const expected = JSON.stringify(item.output)
    return actual === expected ? undefined : `expected ${expected}, got ${actual}`
  }
