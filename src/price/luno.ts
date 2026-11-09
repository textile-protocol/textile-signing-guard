// Luno's public ticker, the one reference price source wired today. The
// response shape checked here is the live one:
//
//   {"pair":"USDCZARU","timestamp":1793281695774,"bid":"16.688","ask":"16.6954",
//    "last_trade":"16.6972","rolling_24_hour_volume":"48048.05","status":"ACTIVE"}
//
// `timestamp` is unix milliseconds. `bid`/`ask` are decimal strings in quote
// currency per one unit of base currency (ZARU per 1 USDC for USDCZARU).

import type { GuardConfig } from '../config.js'
import { err, errorMessage, isRecord, ok, type Result } from '../types.js'
import { cross, formatRational, mid, parseDecimal, spreadBps, spreadWithinBps } from './rational.js'
import { checkRange, MAX_SOURCE_FUTURE_SKEW_MS, type PriceFetcher, type PriceSnapshot } from './reference.js'

type TickerLimits = Pick<GuardConfig['price'], 'maxSpreadBps'>

/**
 * Parse a Luno `GET /api/1/ticker` body. Besides the shape, the book has to be
 * plausible before its mid becomes the reference: a crossed book, a spread
 * wider than `maxSpreadBps` (an illiquid or broken market whose mid means
 * nothing) and a timestamp from the future (a cached or forged response
 * that would never age out) are all refused.
 */
export function parseLunoTicker(body: unknown, expectedPair: string, fetchedAtMs: number, limits: TickerLimits): Result<PriceSnapshot> {
  if (!isRecord(body)) return err('ticker body is not an object')
  if (body['pair'] !== expectedPair) return err(`ticker pair is ${String(body['pair'])}, expected ${expectedPair}`)
  if (body['status'] !== 'ACTIVE') return err(`ticker status is ${String(body['status'])}, not ACTIVE`)
  const ts = body['timestamp']
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return err('ticker timestamp is not a number')
  if (ts > fetchedAtMs + MAX_SOURCE_FUTURE_SKEW_MS) {
    return err(`ticker timestamp ${ts} is ${Math.floor((ts - fetchedAtMs) / 1000)}s in the future`)
  }
  const bid = parseDecimal(body['bid'])
  if (!bid.ok) return err(`ticker bid: ${bid.error}`)
  const ask = parseDecimal(body['ask'])
  if (!ask.ok) return err(`ticker ask: ${ask.error}`)
  if (cross(ask.value, bid.value) < 0n) return err('ticker ask is below bid')
  if (!spreadWithinBps(bid.value, ask.value, limits.maxSpreadBps)) {
    return err(`ticker spread is ${spreadBps(bid.value, ask.value)} bps (bid ${String(body['bid'])}, ask ${String(body['ask'])}), limit ${limits.maxSpreadBps} bps`)
  }
  const m = mid(bid.value, ask.value)
  return ok({ mid: m, priceTimestampMs: ts, fetchedAtMs, pair: expectedPair, display: formatRational(m) })
}

/** The slice of `fetch` the fetcher uses, so tests can stand in for the network. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'error' }
) => Promise<Response>

/** A Luno ticker body is about 200 bytes. Anything near this is not a ticker. */
export const MAX_TICKER_BYTES = 64 * 1024

/** The body as text, or an error once it passes `limit` bytes. Stops reading there. */
const readCapped = async (res: Response, limit: number): Promise<Result<string>> => {
  if (!res.body) return err('ticker response has no body')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > limit) return err(`ticker response is over ${limit} bytes`)
    chunks.push(chunk)
  }
  return ok(Buffer.concat(chunks).toString('utf8'))
}

const parseJson = (text: string): Result<unknown> => {
  try {
    return ok(JSON.parse(text))
  } catch {
    return err('ticker response is not JSON')
  }
}

/**
 * One fetch of the ticker, bounded by `timeoutMs` and `MAX_TICKER_BYTES`, and
 * checked against the configured price range.
 * Redirects are refused: `price.url` is checked to be https at startup, and a
 * redirect could otherwise move the fetch to plain http. Never throws.
 */
export function createLunoFetcher(
  opts: Pick<GuardConfig['price'], 'url' | 'pair' | 'timeoutMs' | 'maxSpreadBps' | 'minPrice' | 'maxPrice'>,
  fetchImpl: FetchLike,
  now: () => number
): PriceFetcher {
  return async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetchImpl(opts.url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'textile-signing-guard' },
        redirect: 'error',
      })
      if (!res.ok) return err(`ticker returned HTTP ${res.status}`)
      const text = await readCapped(res, MAX_TICKER_BYTES)
      if (!text.ok) return text
      const body = parseJson(text.value)
      if (!body.ok) return body
      const snapshot = parseLunoTicker(body.value, opts.pair, now(), { maxSpreadBps: opts.maxSpreadBps })
      return snapshot.ok ? checkRange(snapshot.value, opts) : snapshot
    } catch (e) {
      return err(`ticker fetch failed: ${errorMessage(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
