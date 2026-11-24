import type { Context, Hono } from 'hono'
import { randomBytes } from '../client/crypto.ts'
import { keyPairFromPrivate, responder } from '../protocol/noise.ts'
import { srsPrologue, type ServerKeys } from '../protocol/server-keys.ts'
import { errorDocument, jsonApi } from './app/document.ts'
import type { ChannelStore } from './channels.ts'
import type { AppContext, Env } from './context.ts'

/** Media type of Noise handshake messages and envelopes. */
export const NOISE_MEDIA_TYPE = 'application/vnd.srs.noise'

/** Length of handshake message 1: an ephemeral key and the tag of an empty payload. */
export const MESSAGE_1_LENGTH = 32 + 16

/** Handshakes allowed per client address per minute by default. */
export const DEFAULT_HANDSHAKES_PER_MINUTE = 60

/**
 * A fixed-window counter per client address, held in memory.
 *
 * @param perMinute - Events allowed per address per minute.
 * @returns A function that counts one event and reports whether it is allowed.
 */
export const createWindowLimiter =
  (perMinute: number) => {
    const windows = new Map<string, { count: number, resetAt: number }>()
    return (key: string, now = Date.now()): boolean => {
      if (windows.size > 50_000)
        for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k)
      let entry = windows.get(key)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + 60_000 }
        windows.set(key, entry)
      }
      entry.count += 1
      return entry.count <= perMinute
    }
  }

/**
 * Register `POST /noise/handshake`: read message 1, open a channel, answer
 * with message 2 carrying the channel id (design book, Handshake).
 *
 * Every failure is the same `400`, so a client learns nothing about why.
 *
 * @param app - The app.
 * @param options - The server keys, channel table, client address function and rate limit.
 */
export const registerHandshake =
  ( app: Hono<Env>
  , options:
      { serverKeys: ServerKeys
      , channels: ChannelStore
      , clientOf: (c: Context) => string
      , perMinute?: number
      }) => {
    const prologue = srsPrologue(options.serverKeys)
    const staticKey = keyPairFromPrivate(options.serverKeys.x25519Private)
    const allow = createWindowLimiter(options.perMinute ?? DEFAULT_HANDSHAKES_PER_MINUTE)
    const failed = (c: AppContext) => jsonApi(c, errorDocument(400, 'Bad Request', 'Handshake failed'), 400)

    app.post('/noise/handshake', async c => {
      if (!allow(options.clientOf(c)))
        return jsonApi(c, errorDocument(429, 'Too Many Requests', 'Too many handshakes; try again later'), 429)

      const message = new Uint8Array(await c.req.arrayBuffer())
      if (message.length !== MESSAGE_1_LENGTH) return failed(c)

      const handshake = responder({ prologue, staticKey })
      try {
        // Message 1 carries no payload in this version.
        if (handshake.readMessage1(message).length !== 0) return failed(c)
      } catch {
        return failed(c)
      }

      // Message 2 carries the channel id, so it is chosen first.
      const sid = randomBytes(16)
      const { message: reply, result } = handshake.writeMessage2(sid)
      options.channels.open(sid, result)

      return c.body(reply.slice().buffer as ArrayBuffer, 200, { 'content-type': NOISE_MEDIA_TYPE, 'cache-control': 'no-store' })
    })
  }
