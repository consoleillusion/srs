import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupDatabase, backupName, listBackups, pruneBackups, restoreDatabase, startBackupSchedule, verifyDatabase } from '../../../src/db/backup.ts'
import { applyMigrations } from '../../../src/db/migrate.ts'
import { openDatabase } from '../../../src/db/open.ts'

const ID1 = "X'00000000000000000000000000000001'"
const ID2 = "X'00000000000000000000000000000002'"

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'srs-backup-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** Create a migrated database holding one user named after the argument. */
const seeded =
  async (name: string, file = 'live.db') => {
    const db = await openDatabase(join(dir, file))
    await applyMigrations(db)
    await db.exec(`INSERT INTO user (id, username, owner) VALUES (${ID1}, '${name}', ${ID1})`)
    return db
  }

/** Read every username from a database file. */
const usernames =
  async (file: string) => {
    const db = await openDatabase(file)
    try {
      return ((await (await db.prepare('SELECT username FROM user')).all()) as { username: string }[]).map(x => x.username)
    } finally {
      await db.close()
    }
  }

describe('backupDatabase', () => {
  test('copies a running database and the copy verifies', async () => {
    const db = await seeded('alice')
    const target = join(dir, 'copy.db')
    await backupDatabase(db, target)
    await db.close()
    await verifyDatabase(target)
    expect(await usernames(target)).toEqual(['alice'])
  })

  test('never overwrites an existing file', async () => {
    const db = await seeded('alice')
    const target = join(dir, 'copy.db')
    await writeFile(target, 'keep me')
    await expect(backupDatabase(db, target)).rejects.toThrow('already exists')
    await db.close()
  })

  test('leaves no partial file behind when the copy fails', async () => {
    const db = await seeded('alice')
    await expect(backupDatabase(db, join(dir, 'missing-folder', 'copy.db'))).rejects.toThrow()
    await db.close()
    expect((await readdir(dir)).filter(x => x.includes('partial'))).toEqual([])
  })
})

describe('verifyDatabase', () => {
  test('rejects a file that is not a database', async () => {
    const file = join(dir, 'junk.db')
    await writeFile(file, 'this is not sqlite')
    await expect(verifyDatabase(file)).rejects.toThrow()
  })

  test('rejects a database without the SRS tables', async () => {
    const db = await openDatabase(join(dir, 'other.db'))
    await db.exec('CREATE TABLE unrelated (id INTEGER)')
    await db.close()
    await expect(verifyDatabase(join(dir, 'other.db'))).rejects.toThrow('not an SRS database')
  })
})

describe('restoreDatabase', () => {
  test('replaces the database with the backup', async () => {
    const first = await seeded('before')
    await backupDatabase(first, join(dir, 'good.db'))
    await first.exec(`INSERT INTO user (id, username, owner) VALUES (${ID2}, 'after', ${ID2})`)
    await first.close()

    await restoreDatabase(join(dir, 'good.db'), join(dir, 'live.db'), true)
    expect(await usernames(join(dir, 'live.db'))).toEqual(['before'])
  })

  test('refuses to replace without force and keeps the original', async () => {
    const db = await seeded('original')
    await backupDatabase(db, join(dir, 'good.db'))
    await db.close()
    await expect(restoreDatabase(join(dir, 'good.db'), join(dir, 'live.db'))).rejects.toThrow('--force')
    expect(await usernames(join(dir, 'live.db'))).toEqual(['original'])
  })

  test('refuses a damaged backup and keeps the original', async () => {
    const db = await seeded('original')
    await db.close()
    await writeFile(join(dir, 'bad.db'), 'garbage')
    await expect(restoreDatabase(join(dir, 'bad.db'), join(dir, 'live.db'), true)).rejects.toThrow()
    expect(await usernames(join(dir, 'live.db'))).toEqual(['original'])
  })
})

describe('retention and schedule', () => {
  test('keeps only the newest backups', async () => {
    for (const day of ['01', '02', '03', '04'])
      await writeFile(join(dir, backupName(new Date(`2026-01-${day}T00:00:00Z`))), '')
    await pruneBackups(dir, 2)
    expect(await listBackups(dir)).toEqual([backupName(new Date('2026-01-04T00:00:00Z')), backupName(new Date('2026-01-03T00:00:00Z'))])
  })

  test('takes a backup at startup when none exists and skips it when one is fresh', async () => {
    const db = await seeded('alice')
    const out = join(dir, 'backups')
    const stop = await startBackupSchedule(db, { dir: out, intervalMs: 3_600_000, keep: 3 })
    expect(await listBackups(out)).toHaveLength(1)
    stop()
    const again = await startBackupSchedule(db, { dir: out, intervalMs: 3_600_000, keep: 3 })
    again()
    expect(await listBackups(out)).toHaveLength(1)
    await db.close()
  })

  test('rejects settings that would run in a tight loop', async () => {
    const db = await seeded('alice')
    await expect(startBackupSchedule(db, { dir: join(dir, 'b'), intervalMs: NaN, keep: 3 })).rejects.toThrow('SRS_BACKUP_INTERVAL_HOURS')
    await expect(startBackupSchedule(db, { dir: join(dir, 'b'), intervalMs: 3_600_000, keep: 0 })).rejects.toThrow('SRS_BACKUP_KEEP')
    await db.close()
  })
})
