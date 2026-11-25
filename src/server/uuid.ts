export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A new UUIDv7 (RFC 9562): a 48-bit millisecond timestamp, then random bits,
 * so ids sort by creation time. Portable to Node and Bun.
 */
export const newUuid =
  (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    let time = Date.now()
    for (let i = 5; i >= 0; i--) { bytes[i] = time % 256; time = Math.floor(time / 256) }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

export const canonicalUuid =
  (value: unknown) => {
    if (typeof value === 'string' && UUID_PATTERN.test(value))
      return value.toLowerCase()

    if (value instanceof Uint8Array) {
      if (value.length !== 16)
        throw new Error('Database returned a UUID with an invalid length')
      const hex = Buffer.from(value).toString('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
        + `-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    throw new Error('Expected a UUID')
  }

export const uuidToBuffer =
  (value: string) => {
    if (!UUID_PATTERN.test(value))
      throw new Error(`"${value}" is not a canonical UUID`)
    return Buffer.from(value.replaceAll('-', ''), 'hex')
  }
