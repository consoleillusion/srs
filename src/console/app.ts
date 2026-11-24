/**
 * The browser side of `srs console`: connect to a server over the Noise
 * transport, register or log in, and explore the API. Runs in any browser,
 * including on plain-HTTP pages where `crypto.subtle` is unavailable.
 *
 * @module
 */
import { createSecureClient, type SecureClient } from '../client/secure.ts'

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T
const STORE = 'srs-console'

type Description =
  { attributes: Record<string, { type: string, required: boolean, readOnly: boolean, enum?: unknown[], default?: unknown }>
  , relationships: Record<string, { type: string, cardinality: 'one' | 'many' }>
  }
type CatalogEntry = { type: string, readOnly: boolean, description: Description }

let client: SecureClient | undefined
let catalog: CatalogEntry[] = []

/** Remember the server and fingerprint between visits; never the password. */
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as { url?: string, pin?: string, username?: string }
  } catch {
    return {}
  }
})()
const save =
  () => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ url: $('url').value, pin: $('pin').value, username: $('username').value }))
    } catch {
      // Storage may be unavailable; the console still works.
    }
  }

$('url').value = saved.url ?? (location.port === '5735' ? `${location.protocol}//${location.hostname}:5734` : location.origin)
$('pin').value = saved.pin ?? ''
$('username').value = saved.username ?? ''
$('crypto').textContent =
  globalThis.crypto?.subtle ? '' : 'crypto.subtle unavailable on this page: using pure-JS cryptography'

const status =
  (id: string, text: string, kind: '' | 'good' | 'bad' = '') => {
    const element = $(id)
    element.textContent = text
    element.className = `status ${kind}`
  }

const log =
  (method: string, path: string, outcome: string) => {
    const line = document.createElement('div')
    line.textContent = `${new Date().toLocaleTimeString()}  ${method.padEnd(6)} ${path}  ${outcome}`
    $('log').prepend(line)
  }

const show =
  (statusCode: number | string, value: unknown) => {
    status('response-status', String(statusCode), typeof statusCode === 'number' && statusCode < 400 ? 'good' : 'bad')
    $('response').textContent = value === undefined ? '(no body)' : JSON.stringify(value, null, 2)
  }

/** Run one request through the channel and show the result. */
const send =
  async (method: string, path: string, body?: unknown) => {
    if (!client) return show('—', { error: 'Connect first.' })
    const started = performance.now()
    try {
      const response =
        await client.request(path, body === undefined
          ? { method, headers: { accept: 'application/vnd.api+json' } }
          : { method, headers: { accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' }
            , body: JSON.stringify(body) })
      log(method, path, `${response.status}  ${Math.round(performance.now() - started)} ms`)
      show(response.status, response.json())
      return response
    } catch (error) {
      log(method, path, 'failed')
      show('error', { error: String(error) })
      return undefined
    }
  }

/** A JSON:API document for the selected resource, from the catalog's description. */
const template =
  (entry: CatalogEntry) => {
    const attributes: Record<string, unknown> = {}
    for (const [name, attribute] of Object.entries(entry.description.attributes)) {
      if (attribute.readOnly && name !== 'visibility') continue
      if (name === 'visibility') continue
      attributes[name] =
        attribute.default ?? attribute.enum?.[0]
        ?? (attribute.type === 'integer' || attribute.type === 'number' ? 0 : attribute.type === 'boolean' ? false : '')
    }
    const relationships = Object.fromEntries(
      Object.entries(entry.description.relationships).map(([name, r]) =>
        [name, { data: r.cardinality === 'one' ? { type: r.type, id: '' } : [] }]))
    return { data: { type: entry.type, attributes, ...(Object.keys(relationships).length ? { relationships } : {}) } }
  }

const selected = () => catalog.find(x => x.type === $<HTMLSelectElement>('resource').value)

const loadCatalog =
  async () => {
    const response = await send('GET', '/')
    const resources = (response?.json<{ meta?: { resources?: CatalogEntry[] } }>()?.meta?.resources) ?? []
    if (resources.length === 0) return
    catalog = resources
    const select = $<HTMLSelectElement>('resource')
    select.replaceChildren(...catalog.map(x => new Option(x.readOnly ? `${x.type} (read-only)` : x.type, x.type)))
    $<HTMLTextAreaElement>('body').value = JSON.stringify(template(catalog[0]!), null, 2)
  }

$('connect').onclick = async () => {
  save()
  const pin = $('pin').value.trim()
  if (!pin.startsWith('srs1:')) return status('server-status', 'Enter the server key fingerprint (srs1:…).', 'bad')
  client =
    createSecureClient(
      { baseUrl: $('url').value.trim().replace(/\/+$/, ''), serverKey: pin
      , onServerKeyChange: next => {
          $('pin').value = next
          save()
          status('server-status', `The server rotated its keys; now pinned to ${next}.`, 'good')
        } })
  try {
    await client.request('/healthz')
    status('server-status', 'Connected through an encrypted channel to the pinned server.', 'good')
    await loadCatalog()
  } catch (error) {
    client = undefined
    status('server-status', `Could not connect: ${String(error)}`, 'bad')
  }
}

$('trust').onclick = async () => {
  try {
    const response = await fetch(`${$('url').value.trim().replace(/\/+$/, '')}/noise/keys`)
    const body = await response.json() as { fingerprint?: string }
    if (!body.fingerprint) throw new Error('no fingerprint in the response')
    $('pin').value = body.fingerprint
    save()
    status('server-status', 'Fingerprint taken from the server. Check it against srs init if you can.', '')
  } catch (error) {
    status('server-status', `Could not read the server key: ${String(error)}`, 'bad')
  }
}

const account =
  async (action: 'register' | 'login') => {
    if (!client) return status('account-status', 'Connect first.', 'bad')
    save()
    const input = { username: $('username').value.trim(), password: $('password').value }
    if (!input.username || !input.password) return status('account-status', 'Enter a username and password.', 'bad')
    status('account-status', action === 'register' ? 'Registering…' : 'Logging in…')
    try {
      if (action === 'register') await client.register(input)
      else await client.login(input)
      $('password').value = ''
      status('account-status', `Logged in as ${input.username}. Every request is now signed.`, 'good')
      await loadCatalog()
    } catch (error) {
      status('account-status', String((error as Error).message ?? error), 'bad')
    }
  }
$('register').onclick = () => account('register')
$('login').onclick = () => account('login')
$('logout').onclick = async () => {
  await client?.logout().catch(() => undefined)
  status('account-status', 'Logged out.')
}

$('resource').onchange = () => {
  const entry = selected()
  if (entry) $<HTMLTextAreaElement>('body').value = JSON.stringify(template(entry), null, 2)
}
$('template').onclick = () => $('resource').onchange?.(new Event('change'))

const body =
  () => {
    try {
      return JSON.parse($<HTMLTextAreaElement>('body').value || '{}') as { data?: Record<string, unknown> }
    } catch {
      show('error', { error: 'The document is not valid JSON.' })
      return undefined
    }
  }
const resourcePath = () => `/${$<HTMLSelectElement>('resource').value}`
const idPath = () => `${resourcePath()}/${$('id').value.trim()}`

$('list').onclick = () => send('GET', resourcePath())
$('get').onclick = () => send('GET', idPath())
$('delete').onclick = () => send('DELETE', idPath())
$('create').onclick = async () => {
  const document = body()
  if (!document) return
  const response = await send('POST', resourcePath(), document)
  const id = response?.json<{ data?: { id?: string } }>()?.data?.id
  if (id) $('id').value = id
}
$('update').onclick = () => {
  const document = body()
  if (!document?.data) return
  return send('PATCH', idPath(), { data: { ...document.data, id: $('id').value.trim() } })
}
$('send').onclick = () => {
  const method = $<HTMLSelectElement>('method').value
  const path = $('path').value.trim() || '/'
  if (method === 'GET' || method === 'DELETE') return send(method, path)
  const document = body()
  return document ? send(method, path, document) : undefined
}
