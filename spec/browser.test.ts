import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright-core'

/**
 * Runs `bun run try` exactly as a person would, then drives the console page in
 * a real headless Chrome: once on 127.0.0.1, and once on a LAN address, where
 * the page is not a secure context and `crypto.subtle` is missing (roadmap
 * v0.3.13). Skipped when no Chrome is installed; set CHROME_PATH to point at one.
 */
const chrome =
  [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find(x => x && existsSync(x))
const lan =
  Object.values(networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal)?.address

// Page functions run in the browser; these are the browser globals they use.
declare const document: { querySelector: (s: string) => { textContent: string | null } | null, querySelectorAll: (s: string) => { length: number } }
declare const isSecureContext: boolean

const root = resolve(import.meta.dir, '..')
const serverPort = 15734
const consolePort = 15735
let state = ''
let tryProcess: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
let browser: Browser | undefined
let output = ''

describe.skipIf(!chrome)('console in a real browser', () => {
  beforeAll(async () => {
    state = mkdtempSync(join(tmpdir(), 'srs-try-'))
    tryProcess =
      Bun.spawn(['bun', 'run', 'try', '--host', '0.0.0.0', '--dir', state,
                 '--server-port', String(serverPort), '--console-port', String(consolePort)],
        { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const reader = tryProcess.stdout.getReader()
    const decoder = new TextDecoder()
    while (!output.includes('Ctrl-C')) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`bun run try exited early:\n${output}${await new Response(tryProcess.stderr).text()}`)
      output += decoder.decode(value)
    }
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    tryProcess?.kill('SIGTERM')
    await tryProcess?.exited
    if (state) rmSync(state, { recursive: true, force: true })
  })

  /** Open the link `bun run try` printed for a host, and do everything a person would. */
  const session =
    async (host: string) => {
      const link = output.match(new RegExp(`http://${host.replaceAll('.', '\\.')}:${consolePort}/\\?\\S+`))?.[0]
      expect(link).toBeDefined()
      const page = await browser!.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e)))
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
      await page.goto(link!)

      // Each step waits for its own request to appear in the log, so results never come from the step before.
      const logged = () => page.$$eval('#log div', d => d.length)
      const step =
        async (action: () => Promise<unknown>) => {
          const before = await logged()
          await action()
          await page.waitForFunction(n => document.querySelectorAll('#log div').length > n, before, { timeout: 30_000 })
          return page.textContent('#response-status')
        }

      await step(() => page.click('#connect'))
      expect(await page.textContent('#server-status')).toContain('Connected')
      expect(await page.textContent('#account-status')).toContain('Register or log in')

      await page.fill('#username', `user${Date.now()}${host.length}`)
      await page.fill('#password', 'correct horse battery staple')
      await page.click('#register')
      await page.waitForFunction(() => /Logged in/.test(document.querySelector('#account-status')!.textContent!), null, { timeout: 30_000 })
      expect(await page.$$eval('#resource option', o => o.map(x => (x as unknown as { value: string }).value))).toContain('note')

      await page.selectOption('#resource', 'note')
      await page.fill('#body', JSON.stringify({ data: { type: 'note', attributes: { title: 'from a browser' } } }))
      expect(await step(() => page.click('#create'))).toBe('201')
      expect(await page.inputValue('#id')).toMatch(/^[0-9a-f-]{36}$/)

      await page.fill('#body', JSON.stringify({ data: { type: 'note', attributes: { title: 'edited in a browser' } } }))
      expect(await step(() => page.click('#update'))).toBe('200')
      expect(await step(() => page.click('#list'))).toBe('200')
      expect(await page.textContent('#response')).toContain('edited in a browser')

      await page.fill('#path', '/note?page[size]=1')
      expect(await step(() => page.click('#send'))).toBe('200')
      expect(await step(() => page.click('#delete'))).toBe('204')

      await page.click('#logout')
      await page.waitForFunction(() => /Logged out/.test(document.querySelector('#account-status')!.textContent!))
      await page.fill('#password', 'correct horse battery staple')
      await page.click('#login')
      await page.waitForFunction(() => /Logged in/.test(document.querySelector('#account-status')!.textContent!), null, { timeout: 30_000 })

      const context = await page.evaluate(() => ({ secure: isSecureContext, subtle: Boolean(globalThis.crypto?.subtle) }))
      await page.close()
      expect(errors).toEqual([])
      return context
    }

  test('on 127.0.0.1', async () => {
    expect(await session('127.0.0.1')).toEqual({ secure: true, subtle: true })
  }, 120_000)

  test.skipIf(!lan)('on a LAN address over plain HTTP, without crypto.subtle', async () => {
    expect(await session(lan!)).toEqual({ secure: false, subtle: false })
  }, 120_000)
})
