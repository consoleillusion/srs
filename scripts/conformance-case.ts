/**
 * `bun scripts/conformance-case.ts <case.json…> [--write]`: run new conformance
 * cases and print what this implementation returns. With `--write`, store it
 * as the case's `output` (or `error`). Read every result before committing it:
 * a case is only useful once a person has checked that its expected value is
 * right (design book, Conformance suites).
 *
 * @module
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { operations } from '../spec/conformance/operations.ts'

const write = process.argv.includes('--write')
for (const file of process.argv.slice(2).filter(x => x !== '--write')) {
  const item = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const operation = operations[String(item.operation)]
  if (!operation) throw new Error(`${file}: no operation "${String(item.operation)}"`)
  delete item.output
  delete item.error
  try {
    item.output = await operation(item.input as never)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code !== 'string') throw error
    item.error = code
  }
  const text = `${JSON.stringify(item, null, 2)}\n`
  if (write) writeFileSync(file, text)
  console.log(`== ${file}\n${JSON.stringify(item.output ?? { error: item.error }, null, 2).slice(0, 4000)}\n`)
}
