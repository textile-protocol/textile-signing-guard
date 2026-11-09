// Shared types and the few helpers every module needs. No imports, so any
// module (including the lightweight `healthcheck` command) can use them.

export type Hex = `0x${string}`

/** A checksummed EVM address. Produced only by `normalizeAddress`. */
export type Address = `0x${string}`

/** Either a value or a reason it could not be produced. Never throws. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const err = <T = never>(error: string): Result<T> => ({ ok: false, error })

/** A JSON object (not an array, not null). The one type guard used everywhere. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** `s` cut to `max` characters, noting the original length. For echoing untrusted text. */
export const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}... (${s.length} chars)`)

/** Time as the guard sees it. Injected so tests can pin the clock. */
export type Clock = () => number // unix milliseconds
