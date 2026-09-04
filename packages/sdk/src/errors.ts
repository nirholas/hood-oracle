import type { ApiErrorBody } from './contract.js'

/** Every non-2xx answer from the API, carrying the server's `{ error, message, detail }`. */
export class HoodOracleError extends Error {
  readonly name = 'HoodOracleError'
  constructor(
    /** HTTP status (0 when the request never reached the server). */
    readonly status: number,
    /** The server's error code, e.g. `unauthorized`, `validation`, `not_found`, `rate_limited`, `x402_not_configured`. */
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
    /** The request id echoed by the server, for log correlation. */
    readonly requestId: string | null = null,
  ) {
    super(message)
  }

  static async fromResponse(res: Response): Promise<HoodOracleError> {
    const requestId = res.headers.get('x-request-id')
    let body: Partial<ApiErrorBody> = {}
    try {
      body = (await res.json()) as Partial<ApiErrorBody>
    } catch {
      body = {}
    }
    return new HoodOracleError(res.status, body.error ?? `http_${res.status}`, body.message ?? `${res.status} ${res.statusText}`, body.detail, requestId)
  }
}
