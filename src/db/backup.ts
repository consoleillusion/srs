import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openDatabase, type Database } from './open.ts'

const PREFIX = 'srs-'
const SUFFIX = '.db'

/** Settings for scheduled backups. */
export type BackupSchedule =
  { /** Folder the backups are written to. */
    dir: string
  /** Time between backups, in milliseconds. */
  , intervalMs: number
  /** How many of the newest backups to keep. */
  , keep: number
  /** Called with the time of each successful backup. */
  , onBackup?: (at: number) => void
  }

/** Quote a path as an SQL string literal. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

/** Remove a database file's write-ahead log, which a closed copy no longer needs. */
const removeLogs =
  async (path: string) => {
    await Promise.all([rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })])
  }

/**
 * Check that a file is a healthy SRS database: it opens, passes the integrity
 * check, and holds the system tables.
 *
 * @param path - The database file to check.
 * @throws When the file is missing, damaged, or not an SRS database.
 */
export const verifyDatabase =
  async (path: string): Promise<void> => {
    await stat(path)
    const db = await openDatabase(path)
    try {
      const check = await (await db.prepare('PRAGMA integrity_check')).all() as Record<string, unknown>[]
      if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok')
        throw new Error(`${path} failed the integrity check`)

      const user = await (await db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'user'")).all()
      if (user.length === 0)
        throw new Error(`${path} is not an SRS database (it has no user table)`)
    } finally {
      await db.close()
      await removeLogs(path)
    }
  }

/** The backup file name for a moment in time; sorts oldest to newest. */
export const backupName =
  (when: Date) => `${PREFIX}${when.toISOString().replaceAll(':', '-')}${SUFFIX}`

/**
 * Write a consistent copy of a running database to a new file and verify it.
 *
 * The copy is written under a temporary name and renamed only after it passes
 * the integrity check, so a backup folder never holds a half-written file.
 *
 * @param db - The open database to copy.
 * @param target - The file to create; it must not exist.
 */
export const backupDatabase =
  async (db: Database, target: string): Promise<void> => {
    const finalPath = resolve(target)
    if (await stat(finalPath).then(() => true, () => false))
      throw new Error(`${finalPath} already exists; backups never overwrite a file`)

    const partial = `${finalPath}.partial`
    await rm(partial, { force: true })
    try {
      await db.exec(`VACUUM INTO ${literal(partial)}`)
      await verifyDatabase(partial)
      await rename(partial, finalPath)
    } catch (error) {
      await rm(partial, { force: true })
      await removeLogs(partial)
      throw error
    }
  }

/** List the backup files in a folder, newest first. */
export const listBackups =
  async (dir: string): Promise<string[]> => {
    const names = await readdir(dir).catch(() => [] as string[])
    return names.filter(x => x.startsWith(PREFIX) && x.endsWith(SUFFIX)).sort().reverse()
  }

/** Delete all but the newest `keep` backups. */
export const pruneBackups =
  async (dir: string, keep: number): Promise<void> => {
    for (const name of (await listBackups(dir)).slice(Math.max(keep, 1)))
      await rm(join(dir, name), { force: true })
  }

/**
 * Replace the database file with a verified backup.
 *
 * The server must be stopped: the database holds an exclusive file lock while
 * it runs, and opening it here fails fast rather than corrupting it.
 *
 * @param source - The backup to restore.
 * @param target - The database file to replace.
 * @param force - Allow replacing an existing database file.
 */
export const restoreDatabase =
  async (source: string, target: string, force = false): Promise<void> => {
    await verifyDatabase(source)
    const finalPath = resolve(target)
    if (!force && await stat(finalPath).then(() => true, () => false))
      throw new Error(`${finalPath} already exists; pass --force to replace it`)

    const staged = `${finalPath}.restoring`
    await copyFile(source, staged)
    try {
      await verifyDatabase(staged)
      await removeLogs(finalPath)
      await rename(staged, finalPath)
    } catch (error) {
      await rm(staged, { force: true })
      throw error
    }
  }

/**
 * Back up the database now and then on a timer, keeping the newest few.
 *
 * A backup is taken at startup only when the newest one is older than the
 * interval, so a restart loop does not push good backups out of the folder.
 *
 * @param db - The open database.
 * @param schedule - Where to write, how often, and how many to keep.
 * @returns A function that stops the timer.
 */
export const startBackupSchedule =
  async (db: Database, schedule: BackupSchedule): Promise<() => void> => {
    if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs < 60_000)
      throw new Error('SRS_BACKUP_INTERVAL_HOURS must be a number of hours of at least 1/60')
    if (!Number.isInteger(schedule.keep) || schedule.keep < 1)
      throw new Error('SRS_BACKUP_KEEP must be a whole number of at least 1')
    await mkdir(schedule.dir, { recursive: true })

    const run =
      async () => {
        try {
          const target = join(schedule.dir, backupName(new Date()))
          await backupDatabase(db, target)
          await pruneBackups(schedule.dir, schedule.keep)
          schedule.onBackup?.(Date.now())
          console.log(JSON.stringify({ event: 'backup', file: target }))
        } catch (error) {
          console.error(JSON.stringify({ event: 'backup_failed', error: String(error) }))
        }
      }

    const newest = (await listBackups(schedule.dir))[0]
    const age = newest ? Date.now() - (await stat(join(schedule.dir, newest))).mtimeMs : Infinity
    if (age >= schedule.intervalMs) await run()

    const timer = setInterval(run, schedule.intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }
