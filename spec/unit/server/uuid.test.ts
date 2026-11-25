import { describe, expect, test } from 'bun:test'
import { newUuid, UUID_PATTERN } from '../../../src/server/uuid.ts'

describe('newUuid', () => {
  test('makes version 7, variant 1 ids that sort by creation time', async () => {
    const first = newUuid()
    await Bun.sleep(2)
    const second = newUuid()
    for (const id of [first, second]) {
      expect(id).toMatch(UUID_PATTERN)
      expect(id[14]).toBe('7')
      expect('89ab').toContain(id[19]!)
    }
    expect(first < second).toBe(true)
    expect(Number.parseInt(first.replaceAll('-', '').slice(0, 12), 16)).toBeLessThanOrEqual(Date.now())
  })
})
