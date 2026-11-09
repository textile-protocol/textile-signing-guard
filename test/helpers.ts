// Shared test scaffolding: the Stitch fixtures, a policy config that matches
// them, a pinned clock and a reference price the fixtures sit on.

import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { typedMessageRequest } from '../src/acceptance/stitch.js'
import { parseSignRequest, type SignRequest } from '../src/callback/request.js'
import { type GuardConfig, parseConfig } from '../src/config.js'
import type { PriceSnapshot } from '../src/price/reference.js'
import type { Result } from '../src/types.js'

/** Unwrap a Result in a test, failing loudly with the error. */
export const expectOk = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error)
  return r.value
}

/** One section of a raw config document, for patching in tests. */
export const section = (doc: Record<string, unknown>, name: string): Record<string, unknown> => doc[name] as Record<string, unknown>

export type Fixture = { name: string; digest: `0x${string}`; typedData: Record<string, unknown> }

export const FIXTURES: Fixture[] = (
  JSON.parse(readFileSync(new URL('../../test/fixtures/stitch-typed-data.json', import.meta.url), 'utf8')) as { fixtures: Fixture[] }
).fixtures

export const fixture = (name: string): Fixture => {
  const f = FIXTURES.find((x) => x.name === name)
  if (!f) throw new Error(`no fixture ${name}`)
  return structuredClone(f)
}

export const VAULT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const REACTOR = '0xEb5A29F869FF084B3Fce18d3487a38A56feDC59E'
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const VALIDATION = '0x80a4238ceF3504A24F53D45Ee295b45fD6314Bb2'
export const ZARU = '0xE205b4e7Ac03E3f7b2060C3EDf2171AA7126C0d5'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const TAKER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
export const ATTACKER = '0xbad0000000000000000000000000000000000bad'

/** The fixtures use deadline 1_800_000_120 and issuedAt 1_800_000_000_000 ms. */
export const NOW_MS = 1_800_000_000_000

export const baseConfigDoc = (): Record<string, unknown> => ({
  listen: { host: '127.0.0.1', port: 8443, plain_http: true },
  keys: { cosigner_public_key_file: '/nonexistent/cosigner.pem', handler_private_key_file: '/nonexistent/handler.pem' },
  vault: { address: VAULT, fireblocks_vault_account_id: '0' },
  chain_id: 8453,
  allow: { permit2_orders: true, maker_session: true, maker_enroll: true, signer_check: false, erc20_approve_permit2: false },
  order: {
    permit2: PERMIT2,
    reactor: REACTOR,
    tokens: [
      { symbol: 'ZARU', address: ZARU, decimals: 18 },
      { symbol: 'USDC', address: USDC, decimals: 6 },
    ],
    validation_contracts: ['0x0000000000000000000000000000000000000000', VALIDATION],
    max_input_amount: { ZARU: '500000', USDC: '30000' },
    max_lifetime_secs: 180,
    clock_skew_secs: 10,
  },
  price: {
    url: 'https://api.luno.com/api/1/ticker?pair=USDCZARU',
    pair: 'USDCZARU',
    base_token: 'USDC',
    quote_token: 'ZARU',
    max_deviation_bps: 50,
    min_price: '12',
    max_price: '24',
    max_age_secs: 60,
    refresh_secs: 5,
    timeout_ms: 3000,
  },
  venue: { session_domain_name: 'Textile Maker Session (LIVE)', enroll_domain_name: 'Textile Maker Enroll (LIVE)', max_issued_at_skew_secs: 300 },
  approve: { max_amount: { ZARU: '1000000', USDC: '60000' }, asset_ids: ['BASECHAIN_ETH'] },
})

export const testConfig = (patch: (doc: Record<string, unknown>) => void = () => {}): GuardConfig => {
  const doc = baseConfigDoc()
  patch(doc)
  const r = parseConfig(doc)
  if (!r.ok) throw new Error(`test config invalid: ${r.error}`)
  return r.value
}

/** 16.69 ZARU per USDC, one second old. The fixture orders sit exactly on it. */
export const PRICE: PriceSnapshot = {
  mid: { num: 1669n, den: 100n },
  priceTimestampMs: NOW_MS - 1_000,
  fetchedAtMs: NOW_MS,
  pair: 'USDCZARU',
  display: '16.690000',
}

export const requestFor = (content: unknown, requestId = 'req-1', vaultAccountId = '0'): SignRequest =>
  expectOk(parseSignRequest(typedMessageRequest(content, { requestId, vaultAccountId })))

export const rsaPair = (bits = 2048): { publicKey: KeyObject; privateKey: KeyObject } =>
  generateKeyPairSync('rsa', { modulusLength: bits })

type AnyObj = Record<string, unknown>
/** Follow `path` into a typed-data document and replace the value there. */
export const setPath = (doc: AnyObj, path: string, value: unknown): AnyObj => {
  const parts = path.split('.')
  let cur: AnyObj = doc
  for (const p of parts.slice(0, -1)) {
    const next = cur[p]
    if (typeof next !== 'object' || next === null) throw new Error(`bad path ${path}`)
    cur = next as AnyObj
  }
  cur[parts[parts.length - 1] as string] = value
  return doc
}

/** The spread limit the Luno tests parse with. */
export const TICKER_LIMITS = { maxSpreadBps: 100 }

// Captured from https://api.luno.com/api/1/ticker?pair=USDCZARU on 2026-10-29.
export const LIVE_SAMPLE = {
  pair: 'USDCZARU',
  timestamp: 1793281695774,
  bid: '16.688',
  ask: '16.6954',
  last_trade: '16.6972',
  rolling_24_hour_volume: '48048.05',
  status: 'ACTIVE',
}
