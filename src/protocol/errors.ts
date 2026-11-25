/**
 * A protocol failure with a stable code. Codes are part of the conformance
 * suites, so every implementation reports the same failure the same way. The
 * HTTP layer never shows a code to a client; it answers with one generic error
 * per route (design book, Working on SRS).
 */
export class ProtocolError extends Error {
  /**
   * @param code - Stable code, such as `invalid-length`.
   * @param message - Detail for logs and tests.
   */
  constructor(readonly code: string, message: string = code) {
    super(message)
    this.name = 'ProtocolError'
  }
}
