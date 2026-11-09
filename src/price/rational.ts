// Exact rational arithmetic for prices. No floating point anywhere: a price is
// `num / den` in bigints, token amounts stay in atomic units, and every band
// or spread check is a cross-multiplied inequality.

import { err, ok, type Result } from '../types.js'

export type Rational = { num: bigint; den: bigint }

/** "6000" or "6000.50": no sign, no exponent, no leading zeros, no bare dot. */
export function splitCanonicalDecimal(v: string): { whole: string; frac: string } | null {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(v)
  return m ? { whole: m[1] ?? '0', frac: m[2] ?? '' } : null
}

/** "16.6954" -> 166954 / 10000. Positive only. */
export function parseDecimal(v: unknown): Result<Rational> {
  if (typeof v !== 'string') return err('decimal is not a string')
  const parts = splitCanonicalDecimal(v)
  if (!parts) return err(`not a canonical decimal: ${v}`)
  const num = BigInt(parts.whole + parts.frac)
  if (num <= 0n) return err('decimal must be positive')
  return ok({ num, den: 10n ** BigInt(parts.frac.length) })
}

/** Sign of `a - b` scaled to a common denominator: positive when a > b. */
export const cross = (a: Rational, b: Rational): bigint => a.num * b.den - b.num * a.den

export const mid = (a: Rational, b: Rational): Rational => ({
  num: a.num * b.den + b.num * a.den,
  den: 2n * a.den * b.den,
})

/** Render a rational with `digits` decimals, truncated. For logs only. */
export function formatRational(r: Rational, digits = 6): string {
  const scaled = (r.num * 10n ** BigInt(digits)) / r.den
  const s = scaled.toString().padStart(digits + 1, '0')
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`
}

/**
 * The price an order implies, quote per 1 base:
 * (quoteAtoms / 10^quoteDecimals) / (baseAtoms / 10^baseDecimals).
 */
export function impliedPrice(
  quoteAtoms: bigint,
  quoteDecimals: number,
  baseAtoms: bigint,
  baseDecimals: number
): Result<Rational> {
  if (quoteAtoms <= 0n || baseAtoms <= 0n) return err('amounts must be positive')
  return ok({
    num: quoteAtoms * 10n ** BigInt(baseDecimals),
    den: baseAtoms * 10n ** BigInt(quoteDecimals),
  })
}

/** Signed deviation of `implied` from `reference` in basis points, truncated toward zero. */
export function deviationBps(implied: Rational, reference: Rational): bigint {
  return (10_000n * cross(implied, reference)) / (reference.num * implied.den)
}

/** |implied - reference| <= reference * bps / 10000, exactly. */
export function withinBps(implied: Rational, reference: Rational, bps: number): boolean {
  const diff = cross(implied, reference)
  const abs = diff < 0n ? -diff : diff
  return 10_000n * abs <= BigInt(bps) * reference.num * implied.den
}

/** (ask - bid) / mid in basis points, truncated. For messages; the limit check is exact. */
export function spreadBps(bid: Rational, ask: Rational): bigint {
  const sum = ask.num * bid.den + bid.num * ask.den
  return (20_000n * cross(ask, bid)) / sum
}

/** (ask - bid) / mid <= bps / 10000, without rounding: 20000 (ask - bid) <= bps (ask + bid). */
export function spreadWithinBps(bid: Rational, ask: Rational, bps: number): boolean {
  const sum = ask.num * bid.den + bid.num * ask.den
  return 20_000n * cross(ask, bid) <= BigInt(bps) * sum
}
