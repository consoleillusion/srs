import { createHash } from 'node:crypto'
/** Derive the key-table id stored for a session, so the database never holds the bearer token. */
export const sessionKeyId =
  (token: string) => {
    const digest =
      createHash('sha256')
        .update(`srs-session:${token.toLowerCase()}`)
        .digest()
    return new Uint8Array(digest).slice(0, 16)
  }
