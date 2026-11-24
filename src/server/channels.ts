/**
 * Noise channels, held in memory only (design book, Transport: channel
 * lifetime). A restart ends every channel; clients run a new handshake and
 * resume their login.
 *
 * @module
 */
import { bytesToHex } from '@noble/hashes/utils.js'
import type { HandshakeResult } from '../protocol/noise.ts'

/** Size of the replay window in counters. */
export const REPLAY_WINDOW = 1024n
/** An unauthenticated channel ends after this long. */
export const UNAUTHENTICATED_TTL_MS = 10 * 60_000
/** Every channel ends after this long. */
export const CHANNEL_TTL_MS = 24 * 60 * 60_000
/** A channel ends after this many requests. */
export const MAX_REQUESTS = 2n ** 32n
/** Most channels held at once; the oldest unauthenticated ones go first. */
export const MAX_CHANNELS = 100_000

/** Who a channel is authenticated as, once a session certificate is accepted. */
export type ChannelLogin =
  { userId: string
  , loginId: string
  , sessionPublic: Uint8Array
  , certificateId: string
  , expiresAt: number
  }

/** One Noise channel. */
export type Channel =
  { sid: Uint8Array
  , sidHex: string
  , clientToServer: Uint8Array
  , serverToClient: Uint8Array
  , handshakeHash: Uint8Array
  , createdAt: number
  , highest: bigint
  , seen: bigint
  , requests: bigint
  , login?: ChannelLogin
  }

/** The channel table. */
export type ChannelStore =
  { /** Open a channel with the given 16-byte id for a finished handshake. */
    open: (sid: Uint8Array, result: HandshakeResult, now?: number) => Channel
  /** Find a live channel by id; ended channels are removed and not returned. */
  , get: (sid: Uint8Array, now?: number) => Channel | undefined
  /** Check a counter without recording it: true when it is new and inside the window. */
  , fresh: (channel: Channel, n: bigint) => boolean
  /** Record a counter as used. Call only after the message authenticated. */
  , accept: (channel: Channel, n: bigint) => void
  /** End every channel of a login. */
  , endLogin: (loginId: string) => void
  /** End one channel. */
  , end: (sid: Uint8Array) => void
  /** Number of live channels. */
  , size: () => number
  }

/** Whether a channel has outlived its lifetime. */
const ended =
  (channel: Channel, now: number) =>
    now - channel.createdAt >= CHANNEL_TTL_MS
    || (!channel.login && now - channel.createdAt >= UNAUTHENTICATED_TTL_MS)
    || (channel.login !== undefined && now >= channel.login.expiresAt)
    || channel.requests >= MAX_REQUESTS

/**
 * Create an empty channel table.
 *
 * @returns The table.
 */
export const createChannelStore =
  (): ChannelStore => {
    const channels = new Map<string, Channel>()

    const evict =
      (now: number) => {
        for (const [key, channel] of channels)
          if (ended(channel, now)) channels.delete(key)
        if (channels.size < MAX_CHANNELS) return
        // Still full: drop the oldest unauthenticated channels.
        for (const [key, channel] of channels) {
          if (channels.size < MAX_CHANNELS) break
          if (!channel.login) channels.delete(key)
        }
      }

    return (
      { open: (sid, result, now = Date.now()) => {
          if (channels.size >= MAX_CHANNELS) evict(now)
          const channel: Channel =
            { sid
            , sidHex: bytesToHex(sid)
            , clientToServer: result.initiatorToResponder
            , serverToClient: result.responderToInitiator
            , handshakeHash: result.handshakeHash
            , createdAt: now
            , highest: -1n
            , seen: 0n
            , requests: 0n
            }
          channels.set(channel.sidHex, channel)
          return channel
        }
      , get: (sid, now = Date.now()) => {
          const key = bytesToHex(sid)
          const channel = channels.get(key)
          if (!channel) return undefined
          if (ended(channel, now)) {
            channels.delete(key)
            return undefined
          }
          return channel
        }
      , fresh: (channel, n) => {
          if (n < 0n) return false
          if (n > channel.highest) return true
          const offset = channel.highest - n
          if (offset >= REPLAY_WINDOW) return false
          return ((channel.seen >> offset) & 1n) === 0n
        }
      , accept: (channel, n) => {
          if (n > channel.highest) {
            const shift = channel.highest < 0n ? REPLAY_WINDOW : n - channel.highest
            channel.seen = shift >= REPLAY_WINDOW ? 1n : ((channel.seen << shift) | 1n) & ((1n << REPLAY_WINDOW) - 1n)
            channel.highest = n
          } else {
            channel.seen |= 1n << (channel.highest - n)
          }
          channel.requests += 1n
        }
      , endLogin: loginId => {
          for (const [key, channel] of channels)
            if (channel.login?.loginId === loginId) channels.delete(key)
        }
      , end: sid => {
          channels.delete(bytesToHex(sid))
        }
      , size: () => channels.size
      })
  }
