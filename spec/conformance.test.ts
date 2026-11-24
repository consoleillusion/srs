import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { operations } from './conformance/operations.ts'
import { CONFORMANCE_ROOT, loadSuite, runCase } from './conformance/runner.ts'

const suites = readdirSync(CONFORMANCE_ROOT, { withFileTypes: true })
  .filter(x => x.isDirectory() && x.name !== 'tools')
  .map(x => x.name)

for (const suite of suites)
  describe(`conformance: ${suite}`, () => {
    for (const [file, item] of loadSuite(suite))
      test(`${file}: ${item.description}`, () => {
        expect(typeof item.operation).toBe('string')
        expect((item.output === undefined) !== (item.error === undefined)).toBe(true)
        expect(runCase(operations, item)).toBeUndefined()
      })
  })
