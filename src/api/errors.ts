import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** Every API error is `{ error: code, message }` with a meaningful HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toJSON(): { error: string; message: string; detail?: Record<string, unknown> } {
    return this.detail ? { error: this.code, message: this.message, detail: this.detail } : { error: this.code, message: this.message }
  }
}

export const badRequest = (message: string, detail?: Record<string, unknown>) => new ApiError(400, 'validation', message, detail)
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`)
export const conflict = (code: string, message: string, detail?: Record<string, unknown>) => new ApiError(409, code, message, detail)
