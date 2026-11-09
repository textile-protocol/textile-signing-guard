// The reference price: the latest snapshot from the ticker, how stale it is,
// and the background poller that keeps it fresh so a decision never waits on
// the network.

import type { GuardConfig } from '../config.js'
import { err, ok, type Result } from '../types.js'
import { cross, formatRational, type Rational } from './rational.js'

export type PriceSnapshot = {
  /** Mid price, quote per 1 base, as a fraction. */
  mid: Rational
  /** The source's own timestamp for the quote. */
  priceTimestampMs: number
  /** When this process fetched it. */
  fetchedAtMs: number
  pair: string
  /** Human form for logs, e.g. "16.6917". */
  display: string
}

/** A source timestamp may run a little ahead of our clock, not more. */
export const MAX_SOURCE_FUTURE_SKEW_MS = 60_000

type PriceRange = Pick<GuardConfig['price'], 'minPrice' | 'maxPrice'>

/**
 * Refuse a mid outside the configured range. It catches what the band cannot:
 * a source quoting the inverse pair, a price off by a power of ten, or one
 * pushed far from reality, any of which would move the band with it.
 */
export function checkRange(s: PriceSnapshot, range: PriceRange): Result<PriceSnapshot> {
  if (cross(s.mid, range.minPrice) < 0n || cross(s.mid, range.maxPrice) > 0n) {
    return err(`reference ${s.display} is outside the configured range ${formatRational(range.minPrice)} to ${formatRational(range.maxPrice)}`)
  }
  return ok(s)
}

/** How long ago this process fetched the snapshot. */
export const fetchAgeMs = (s: PriceSnapshot, nowMs: number): number => nowMs - s.fetchedAtMs

/** How old the source says its quote is. Luno's `timestamp` is the last book
 * update, so on a thin pair it can lag minutes while the quote is still live. */
export const sourceAgeMs = (s: PriceSnapshot, nowMs: number): number => nowMs - s.priceTimestampMs

type StalenessLimits = Pick<GuardConfig['price'], 'maxAgeSecs' | 'maxSourceAgeSecs'>

/** `null` when the snapshot is usable, otherwise the reason it is not. */
export function staleness(s: PriceSnapshot | null, nowMs: number, limits: StalenessLimits): string | null {
  if (!s) return 'no reference price has been fetched yet'
  const fetchAge = fetchAgeMs(s, nowMs)
  if (fetchAge > limits.maxAgeSecs * 1000) {
    return `the guard last fetched the reference price ${Math.floor(fetchAge / 1000)}s ago, limit ${limits.maxAgeSecs}s`
  }
  const sourceAge = sourceAgeMs(s, nowMs)
  if (sourceAge > limits.maxSourceAgeSecs * 1000) {
    return `the source's quote timestamp is ${Math.floor(sourceAge / 1000)}s old, limit ${limits.maxSourceAgeSecs}s`
  }
  if (sourceAge < -MAX_SOURCE_FUTURE_SKEW_MS) {
    return `the source's quote timestamp is ${Math.floor(-sourceAge / 1000)}s in the future`
  }
  return null
}

export type PriceFetcher = () => Promise<Result<PriceSnapshot>>

export type PricePoller = {
  start: () => Promise<void>
  stop: () => void
  current: () => PriceSnapshot | null
}

/**
 * Keep the latest good snapshot in memory so a decision never waits on the
 * network. Staleness is judged at decision time against `max_age_secs`, so a
 * poller that keeps failing simply lets the snapshot age into a reject.
 */
export function createPricePoller(
  fetcher: PriceFetcher,
  refreshMs: number,
  onEvent: (event: 'price_update' | 'price_error', fields: Record<string, string | number>) => void
): PricePoller {
  let snapshot: PriceSnapshot | null = null
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const tick = async () => {
    const r = await fetcher()
    if (r.ok) {
      snapshot = r.value
      onEvent('price_update', { pair: r.value.pair, mid: r.value.display, priceTimestampMs: r.value.priceTimestampMs })
    } else {
      onEvent('price_error', { error: r.error })
    }
    if (!stopped) timer = setTimeout(() => void tick(), refreshMs)
  }

  return {
    start: async () => {
      await tick()
    },
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    current: () => snapshot,
  }
}
