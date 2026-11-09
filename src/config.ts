// Guard Policy configuration: a JSON file, parsed strictly.
//
// Every key is checked for presence and type, unknown keys are an error, and
// addresses are checksummed. The service refuses to start on any problem, so
// a typo in the config can never turn into a guard that approves by accident.
// Human-readable amounts ("6000.50") are converted to atomic units here, once,
// with the token's configured decimals.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { normalizeAddress } from './policy/typedData.js'
import { cross, formatRational, parseDecimal, type Rational, splitCanonicalDecimal } from './price/rational.js'
import { err, errorMessage, isRecord, ok, type Address, type Result } from './types.js'

export type TokenConfig = { symbol: string; address: Address; decimals: number }

export type GuardConfig = {
  listen: {
    host: string
    port: number
    tls: { certFile: string; keyFile: string } | null
    /** Only valid behind a TLS-terminating proxy on the same host or pod. */
    plainHttp: boolean
  }
  keys: { cosignerPublicKeyFile: string; handlerPrivateKeyFile: string }
  vault: { address: Address; fireblocksVaultAccountId: string | null }
  chainId: number
  allow: {
    permit2Orders: boolean
    makerSession: boolean
    makerEnroll: boolean
    signerCheck: boolean
    erc20ApprovePermit2: boolean
  }
  order: {
    permit2: Address
    reactor: Address
    tokens: TokenConfig[]
    /** `null` means the field is not checked. */
    validationContracts: Address[] | null
    /** Atomic units, keyed by token symbol. */
    maxInputAmount: Record<string, bigint>
    maxLifetimeSecs: number
    clockSkewSecs: number
  }
  price: {
    url: string
    pair: string
    /** The ticker quotes `quoteToken` per 1 `baseToken`. */
    baseToken: string
    quoteToken: string
    maxDeviationBps: number
    /** The plausible range for the reference, quote per 1 base. A mid outside it is refused. */
    minPrice: Rational
    maxPrice: Rational
    /** Widest bid/ask spread whose mid still counts as a reference. */
    maxSpreadBps: number
    /** How long ago this process last fetched the ticker. */
    maxAgeSecs: number
    /** How old the ticker's own timestamp may be (thin books update rarely). */
    maxSourceAgeSecs: number
    refreshSecs: number
    timeoutMs: number
  }
  venue: {
    sessionDomainName: string
    enrollDomainName: string
    fundingWallet: Address
    maxIssuedAtSkewSecs: number
  }
  approve: { maxAmount: Record<string, bigint>; assetIds: string[] } | null
  signingPayload: { require: boolean }
  configChangeAction: 'REJECT' | 'IGNORE'
  jwt: { clockSkewSecs: number }
}

export type LoadedConfig = { config: GuardConfig; sha256: string; path: string }

type Obj = Record<string, unknown>

// --- small validators, all returning Result with the JSON path in the error ---

const at = (path: string, msg: string) => `${path}: ${msg}`

const obj = (v: unknown, path: string, keys: readonly string[]): Result<Obj> => {
  if (!isRecord(v)) return err(at(path, 'must be an object'))
  const extra = Object.keys(v).filter((k) => !keys.includes(k))
  if (extra.length > 0) return err(at(path, `unknown keys: ${extra.join(', ')}`))
  return ok(v)
}

const str = (v: unknown, path: string): Result<string> =>
  typeof v === 'string' && v.length > 0 ? ok(v) : err(at(path, 'must be a non-empty string'))

const bool = (v: unknown, path: string): Result<boolean> =>
  typeof v === 'boolean' ? ok(v) : err(at(path, 'must be true or false'))

const int = (v: unknown, path: string, min: number, max: number): Result<number> =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? ok(v)
    : err(at(path, `must be an integer between ${min} and ${max}`))

/** A positive decimal string, e.g. "16.5", as an exact rational. */
const price = (v: unknown, path: string): Result<Rational> => {
  const r = parseDecimal(v)
  return r.ok ? r : err(at(path, `must be a positive decimal string like "16.5" (${r.error})`))
}

const addr = (v: unknown, path: string): Result<Address> => {
  const r = normalizeAddress(v)
  return r.ok ? r : err(at(path, r.error))
}

const optional = <T>(v: unknown, parse: (v: unknown) => Result<T>): Result<T | null> =>
  v === undefined || v === null ? ok(null) : parse(v)

/** An absent key takes the default; a present one is parsed. */
const withDefault = <T>(v: unknown, dflt: T, parse: (v: unknown) => Result<T>): Result<T> =>
  v === undefined ? ok(dflt) : parse(v)

const isHttpsUrl = (v: string): boolean => {
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}

const oneOf = <T extends string>(v: unknown, path: string, allowed: readonly T[]): Result<T> =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? ok(v as T)
    : err(at(path, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`))

/** "6000.50" with `decimals` = 6 becomes 6000500000n. No floats involved. */
export function parseDecimalToAtomic(v: unknown, decimals: number, path: string): Result<bigint> {
  if (typeof v !== 'string') return err(at(path, 'must be a decimal string like "6000" or "6000.50"'))
  const parts = splitCanonicalDecimal(v)
  if (!parts) return err(at(path, 'must be a canonical decimal string'))
  if (parts.frac.length > decimals) return err(at(path, `has more than ${decimals} fractional digits`))
  const atomic = BigInt(parts.whole + parts.frac.padEnd(decimals, '0'))
  if (atomic <= 0n) return err(at(path, 'must be greater than zero'))
  return ok(atomic)
}

const amountsBySymbol = (
  v: unknown,
  path: string,
  tokens: TokenConfig[],
  requireAll: boolean
): Result<Record<string, bigint>> => {
  const symbols = tokens.map((t) => t.symbol)
  const o = obj(v, path, symbols)
  if (!o.ok) return o
  if (requireAll) {
    const missing = symbols.filter((s) => !(s in o.value))
    if (missing.length > 0) return err(at(path, `missing an amount for ${missing.join(', ')}`))
  }
  const out: Record<string, bigint> = {}
  for (const token of tokens) {
    if (!(token.symbol in o.value)) continue
    const r = parseDecimalToAtomic(o.value[token.symbol], token.decimals, `${path}.${token.symbol}`)
    if (!r.ok) return r
    out[token.symbol] = r.value
  }
  return ok(out)
}

const tokenList = (v: unknown, path: string): Result<TokenConfig[]> => {
  if (!Array.isArray(v) || v.length !== 2) return err(at(path, 'must list exactly two tokens'))
  const out: TokenConfig[] = []
  for (const [i, item] of v.entries()) {
    const p = `${path}[${i}]`
    const o = obj(item, p, ['symbol', 'address', 'decimals'])
    if (!o.ok) return o
    const symbol = str(o.value['symbol'], `${p}.symbol`)
    if (!symbol.ok) return symbol
    if (!/^[A-Z0-9]{2,12}$/.test(symbol.value)) return err(at(`${p}.symbol`, 'must be 2 to 12 upper-case letters or digits'))
    const address = addr(o.value['address'], `${p}.address`)
    if (!address.ok) return address
    const decimals = int(o.value['decimals'], `${p}.decimals`, 0, 36)
    if (!decimals.ok) return decimals
    out.push({ symbol: symbol.value, address: address.value, decimals: decimals.value })
  }
  const [a, b] = out as [TokenConfig, TokenConfig]
  if (a.symbol === b.symbol) return err(at(path, 'token symbols must differ'))
  if (a.address.toLowerCase() === b.address.toLowerCase()) return err(at(path, 'token addresses must differ'))
  return ok(out)
}

const addressList = (v: unknown, path: string): Result<Address[]> => {
  if (!Array.isArray(v) || v.length === 0) return err(at(path, 'must be a non-empty array of addresses'))
  const out: Address[] = []
  for (const [i, item] of v.entries()) {
    const a = addr(item, `${path}[${i}]`)
    if (!a.ok) return a
    out.push(a.value)
  }
  return ok(out)
}

const stringList = (v: unknown, path: string): Result<string[]> => {
  if (!Array.isArray(v) || v.length === 0) return err(at(path, 'must be a non-empty array of strings'))
  const out: string[] = []
  for (const [i, item] of v.entries()) {
    const s = str(item, `${path}[${i}]`)
    if (!s.ok) return s
    out.push(s.value)
  }
  return ok(out)
}

// --- sections ----------------------------------------------------------------

const parseListen = (v: unknown): Result<GuardConfig['listen']> => {
  const o = obj(v, 'listen', ['host', 'port', 'tls', 'plain_http'])
  if (!o.ok) return o
  const host = str(o.value['host'], 'listen.host')
  if (!host.ok) return host
  const port = int(o.value['port'], 'listen.port', 1, 65535)
  if (!port.ok) return port
  const plainHttp = withDefault(o.value['plain_http'], false, (x) => bool(x, 'listen.plain_http'))
  if (!plainHttp.ok) return plainHttp
  const tls = optional(o.value['tls'], (t) => {
    const to = obj(t, 'listen.tls', ['cert_file', 'key_file'])
    if (!to.ok) return to
    const certFile = str(to.value['cert_file'], 'listen.tls.cert_file')
    if (!certFile.ok) return certFile
    const keyFile = str(to.value['key_file'], 'listen.tls.key_file')
    if (!keyFile.ok) return keyFile
    return ok({ certFile: certFile.value, keyFile: keyFile.value })
  })
  if (!tls.ok) return tls
  if (tls.value && plainHttp.value) return err('listen: set either tls or plain_http, not both')
  if (!tls.value && !plainHttp.value) {
    return err('listen: the co-signer requires HTTPS. Set listen.tls, or listen.plain_http = true only behind a TLS-terminating proxy')
  }
  return ok({ host: host.value, port: port.value, tls: tls.value, plainHttp: plainHttp.value })
}

const parseKeys = (v: unknown): Result<GuardConfig['keys']> => {
  const o = obj(v, 'keys', ['cosigner_public_key_file', 'handler_private_key_file'])
  if (!o.ok) return o
  const pub = str(o.value['cosigner_public_key_file'], 'keys.cosigner_public_key_file')
  if (!pub.ok) return pub
  const priv = str(o.value['handler_private_key_file'], 'keys.handler_private_key_file')
  if (!priv.ok) return priv
  return ok({ cosignerPublicKeyFile: pub.value, handlerPrivateKeyFile: priv.value })
}

const parseVault = (v: unknown): Result<GuardConfig['vault']> => {
  const o = obj(v, 'vault', ['address', 'fireblocks_vault_account_id'])
  if (!o.ok) return o
  const address = addr(o.value['address'], 'vault.address')
  if (!address.ok) return address
  const id = optional(o.value['fireblocks_vault_account_id'], (x) =>
    typeof x === 'number' && Number.isInteger(x) && x >= 0 ? ok(String(x)) : str(x, 'vault.fireblocks_vault_account_id')
  )
  if (!id.ok) return id
  return ok({ address: address.value, fireblocksVaultAccountId: id.value })
}

const parseAllow = (v: unknown): Result<GuardConfig['allow']> => {
  const keys = ['permit2_orders', 'maker_session', 'maker_enroll', 'signer_check', 'erc20_approve_permit2'] as const
  const o = obj(v, 'allow', keys)
  if (!o.ok) return o
  const read = (k: (typeof keys)[number], dflt: boolean) => withDefault(o.value[k], dflt, (x) => bool(x, `allow.${k}`))
  const permit2Orders = read('permit2_orders', true)
  if (!permit2Orders.ok) return permit2Orders
  const makerSession = read('maker_session', true)
  if (!makerSession.ok) return makerSession
  const makerEnroll = read('maker_enroll', true)
  if (!makerEnroll.ok) return makerEnroll
  // Off by default: trading does not need it; it backs Stitch's panel Verify button.
  const signerCheck = read('signer_check', false)
  if (!signerCheck.ok) return signerCheck
  // Off by default: a contract call is a transaction, not a quote.
  const erc20ApprovePermit2 = read('erc20_approve_permit2', false)
  if (!erc20ApprovePermit2.ok) return erc20ApprovePermit2
  return ok({
    permit2Orders: permit2Orders.value,
    makerSession: makerSession.value,
    makerEnroll: makerEnroll.value,
    signerCheck: signerCheck.value,
    erc20ApprovePermit2: erc20ApprovePermit2.value,
  })
}

const parseOrder = (v: unknown): Result<GuardConfig['order']> => {
  const o = obj(v, 'order', [
    'permit2',
    'reactor',
    'tokens',
    'validation_contracts',
    'max_input_amount',
    'max_lifetime_secs',
    'clock_skew_secs',
  ])
  if (!o.ok) return o
  const permit2 = addr(o.value['permit2'], 'order.permit2')
  if (!permit2.ok) return permit2
  const reactor = addr(o.value['reactor'], 'order.reactor')
  if (!reactor.ok) return reactor
  const tokens = tokenList(o.value['tokens'], 'order.tokens')
  if (!tokens.ok) return tokens
  const validationContracts = optional(o.value['validation_contracts'], (x) => addressList(x, 'order.validation_contracts'))
  if (!validationContracts.ok) return validationContracts
  const maxInputAmount = amountsBySymbol(o.value['max_input_amount'], 'order.max_input_amount', tokens.value, true)
  if (!maxInputAmount.ok) return maxInputAmount
  const maxLifetimeSecs = int(o.value['max_lifetime_secs'], 'order.max_lifetime_secs', 1, 86_400)
  if (!maxLifetimeSecs.ok) return maxLifetimeSecs
  const clockSkewSecs = int(o.value['clock_skew_secs'], 'order.clock_skew_secs', 0, 300)
  if (!clockSkewSecs.ok) return clockSkewSecs
  return ok({
    permit2: permit2.value,
    reactor: reactor.value,
    tokens: tokens.value,
    validationContracts: validationContracts.value,
    maxInputAmount: maxInputAmount.value,
    maxLifetimeSecs: maxLifetimeSecs.value,
    clockSkewSecs: clockSkewSecs.value,
  })
}

const parsePrice = (v: unknown, tokens: TokenConfig[]): Result<GuardConfig['price']> => {
  const o = obj(v, 'price', [
    'url',
    'pair',
    'base_token',
    'quote_token',
    'max_deviation_bps',
    'min_price',
    'max_price',
    'max_spread_bps',
    'max_age_secs',
    'max_source_age_secs',
    'refresh_secs',
    'timeout_ms',
  ])
  if (!o.ok) return o
  const url = str(o.value['url'], 'price.url')
  if (!url.ok) return url
  if (!isHttpsUrl(url.value)) return err('price.url: must be an https URL')
  const pair = str(o.value['pair'], 'price.pair')
  if (!pair.ok) return pair
  const symbols = tokens.map((t) => t.symbol)
  const baseToken = str(o.value['base_token'], 'price.base_token')
  if (!baseToken.ok) return baseToken
  const quoteToken = str(o.value['quote_token'], 'price.quote_token')
  if (!quoteToken.ok) return quoteToken
  if (!symbols.includes(baseToken.value) || !symbols.includes(quoteToken.value) || baseToken.value === quoteToken.value) {
    return err(`price: base_token and quote_token must be the two configured tokens (${symbols.join(', ')})`)
  }
  const maxDeviationBps = int(o.value['max_deviation_bps'], 'price.max_deviation_bps', 1, 5_000)
  if (!maxDeviationBps.ok) return maxDeviationBps
  const minPrice = price(o.value['min_price'], 'price.min_price')
  if (!minPrice.ok) return minPrice
  const maxPrice = price(o.value['max_price'], 'price.max_price')
  if (!maxPrice.ok) return maxPrice
  if (cross(minPrice.value, maxPrice.value) >= 0n) return err('price.min_price must be below price.max_price')
  const maxSpreadBps = withDefault(o.value['max_spread_bps'], 300, (x) => int(x, 'price.max_spread_bps', 1, 5_000))
  if (!maxSpreadBps.ok) return maxSpreadBps
  const maxAgeSecs = withDefault(o.value['max_age_secs'], 60, (x) => int(x, 'price.max_age_secs', 1, 3_600))
  if (!maxAgeSecs.ok) return maxAgeSecs
  const maxSourceAgeSecs = withDefault(o.value['max_source_age_secs'], 600, (x) => int(x, 'price.max_source_age_secs', 1, 86_400))
  if (!maxSourceAgeSecs.ok) return maxSourceAgeSecs
  const refreshSecs = withDefault(o.value['refresh_secs'], 5, (x) => int(x, 'price.refresh_secs', 1, 600))
  if (!refreshSecs.ok) return refreshSecs
  if (refreshSecs.value >= maxAgeSecs.value) return err('price.refresh_secs must be smaller than price.max_age_secs')
  const timeoutMs = withDefault(o.value['timeout_ms'], 3_000, (x) => int(x, 'price.timeout_ms', 100, 30_000))
  if (!timeoutMs.ok) return timeoutMs
  return ok({
    url: url.value,
    pair: pair.value,
    baseToken: baseToken.value,
    quoteToken: quoteToken.value,
    maxDeviationBps: maxDeviationBps.value,
    minPrice: minPrice.value,
    maxPrice: maxPrice.value,
    maxSpreadBps: maxSpreadBps.value,
    maxAgeSecs: maxAgeSecs.value,
    maxSourceAgeSecs: maxSourceAgeSecs.value,
    refreshSecs: refreshSecs.value,
    timeoutMs: timeoutMs.value,
  })
}

const parseVenue = (v: unknown, vault: Address): Result<GuardConfig['venue']> => {
  const o = obj(v, 'venue', ['session_domain_name', 'enroll_domain_name', 'funding_wallet', 'max_issued_at_skew_secs'])
  if (!o.ok) return o
  const session = str(o.value['session_domain_name'], 'venue.session_domain_name')
  if (!session.ok) return session
  const enroll = str(o.value['enroll_domain_name'], 'venue.enroll_domain_name')
  if (!enroll.ok) return enroll
  const fundingWallet = optional(o.value['funding_wallet'], (x) => addr(x, 'venue.funding_wallet'))
  if (!fundingWallet.ok) return fundingWallet
  // An OperatorVault setup (the key is the vault's strategy signer) also signs
  // NavAttestation messages for epoch settlement, which this policy does not
  // allow, so the guard would block settlement while approving orders. Refuse
  // the configuration until that message kind is part of the policy.
  if (fundingWallet.value && fundingWallet.value.toLowerCase() !== vault.toLowerCase()) {
    return err(
      'venue.funding_wallet: OperatorVault setups are not supported yet (the guard would block the NavAttestation co-signatures Stitch signs for epoch settlement). Leave it unset; it defaults to vault.address'
    )
  }
  const skew = withDefault(o.value['max_issued_at_skew_secs'], 300, (x) => int(x, 'venue.max_issued_at_skew_secs', 1, 3_600))
  if (!skew.ok) return skew
  return ok({
    sessionDomainName: session.value,
    enrollDomainName: enroll.value,
    fundingWallet: fundingWallet.value ?? vault,
    maxIssuedAtSkewSecs: skew.value,
  })
}

const parseApprove = (v: unknown, tokens: TokenConfig[]): Result<GuardConfig['approve']> => {
  const o = obj(v, 'approve', ['max_amount', 'asset_ids'])
  if (!o.ok) return o
  const maxAmount = amountsBySymbol(o.value['max_amount'], 'approve.max_amount', tokens, false)
  if (!maxAmount.ok) return maxAmount
  if (Object.keys(maxAmount.value).length === 0) return err('approve.max_amount: list at least one token')
  const assetIds = stringList(o.value['asset_ids'], 'approve.asset_ids')
  if (!assetIds.ok) return assetIds
  return ok({ maxAmount: maxAmount.value, assetIds: assetIds.value })
}

const parseSigningPayload = (v: unknown): Result<GuardConfig['signingPayload']> => {
  const o = obj(v, 'signing_payload', ['require'])
  if (!o.ok) return o
  const require = withDefault(o.value['require'], false, (x) => bool(x, 'signing_payload.require'))
  return require.ok ? ok({ require: require.value }) : require
}

const parseJwt = (v: unknown): Result<GuardConfig['jwt']> => {
  const o = obj(v, 'jwt', ['clock_skew_secs'])
  if (!o.ok) return o
  const skew = withDefault(o.value['clock_skew_secs'], 60, (x) => int(x, 'jwt.clock_skew_secs', 0, 600))
  return skew.ok ? ok({ clockSkewSecs: skew.value }) : skew
}

const TOP_KEYS = [
  'listen',
  'keys',
  'vault',
  'chain_id',
  'allow',
  'order',
  'price',
  'venue',
  'approve',
  'signing_payload',
  'config_change_action',
  'jwt',
] as const

/** Validate a parsed JSON document. Pure; file I/O lives in `loadConfigFile`. */
export function parseConfig(doc: unknown): Result<GuardConfig> {
  const o = obj(doc, 'config', TOP_KEYS)
  if (!o.ok) return o
  const listen = parseListen(o.value['listen'])
  if (!listen.ok) return listen
  const keys = parseKeys(o.value['keys'])
  if (!keys.ok) return keys
  const vault = parseVault(o.value['vault'])
  if (!vault.ok) return vault
  const chainId = int(o.value['chain_id'], 'chain_id', 1, Number.MAX_SAFE_INTEGER)
  if (!chainId.ok) return chainId
  const allow = parseAllow(o.value['allow'] ?? {})
  if (!allow.ok) return allow
  const order = parseOrder(o.value['order'])
  if (!order.ok) return order
  const price = parsePrice(o.value['price'], order.value.tokens)
  if (!price.ok) return price
  const venue = parseVenue(o.value['venue'], vault.value.address)
  if (!venue.ok) return venue
  const approve = optional(o.value['approve'], (x) => parseApprove(x, order.value.tokens))
  if (!approve.ok) return approve
  if (allow.value.erc20ApprovePermit2 && !approve.value) {
    return err('allow.erc20_approve_permit2 is on but the approve section is missing')
  }
  // A contract call is a real transaction from whichever account asked, so the
  // opt-in is only allowed with the source pinned to the vault's account.
  if (allow.value.erc20ApprovePermit2 && vault.value.fireblocksVaultAccountId === null) {
    return err('allow.erc20_approve_permit2 needs vault.fireblocks_vault_account_id')
  }
  const signingPayload = parseSigningPayload(o.value['signing_payload'] ?? {})
  if (!signingPayload.ok) return signingPayload
  const configChangeAction = withDefault(o.value['config_change_action'], 'REJECT' as const, (x) =>
    oneOf(x, 'config_change_action', ['REJECT', 'IGNORE'] as const)
  )
  if (!configChangeAction.ok) return configChangeAction
  const jwt = parseJwt(o.value['jwt'] ?? {})
  if (!jwt.ok) return jwt

  return ok({
    listen: listen.value,
    keys: keys.value,
    vault: vault.value,
    chainId: chainId.value,
    allow: allow.value,
    order: order.value,
    price: price.value,
    venue: venue.value,
    approve: approve.value,
    signingPayload: signingPayload.value,
    configChangeAction: configChangeAction.value,
    jwt: jwt.value,
  })
}

/** Read, parse and validate the config file. The sha256 is of the raw bytes. */
export function loadConfigFile(path: string): Result<LoadedConfig> {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (e) {
    return err(`cannot read config ${path}: ${errorMessage(e)}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    return err(`config ${path} is not valid JSON: ${errorMessage(e)}`)
  }
  const parsed = parseConfig(doc)
  if (!parsed.ok) return parsed
  return ok({ config: parsed.value, sha256: createHash('sha256').update(raw).digest('hex'), path })
}

export const tokenBySymbol = (cfg: GuardConfig, symbol: string): TokenConfig | null =>
  cfg.order.tokens.find((t) => t.symbol === symbol) ?? null

export const tokenByAddress = (cfg: GuardConfig, address: string): TokenConfig | null =>
  cfg.order.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase()) ?? null

/** The ticker's base and quote tokens. `parsePrice` guarantees both exist. */
export const priceTokens = (cfg: GuardConfig): { base: TokenConfig; quote: TokenConfig } => {
  const base = tokenBySymbol(cfg, cfg.price.baseToken)
  const quote = tokenBySymbol(cfg, cfg.price.quoteToken)
  if (!base || !quote) throw new Error('config invariant violated: price tokens are not configured tokens')
  return { base, quote }
}

/** An exact decimal without trailing zeros: 5000000000n atoms at 6 decimals is "5000". */
const plain = (r: Rational, digits: number): string => formatRational(r, digits).replace(/\.?0+$/, '')

/**
 * The policy in plain units, for check-config and the startup log. It spells
 * out each token's decimals, each cap in atoms and the price orientation: a
 * slip in any of them makes the guard approve the wrong amounts, and the
 * acceptance suite (built from the same config) cannot see it.
 */
export function describeConfig(cfg: GuardConfig): Record<string, string> {
  const { base, quote } = priceTokens(cfg)
  const { minPrice, maxPrice, maxDeviationBps, url } = cfg.price
  return {
    tokens: cfg.order.tokens.map((t) => `${t.symbol}=${t.address} (${t.decimals} decimals)`).join(', '),
    orderCaps: cfg.order.tokens
      .map((t) => {
        const cap = cfg.order.maxInputAmount[t.symbol] ?? 0n
        return `${t.symbol} ${plain({ num: cap, den: 10n ** BigInt(t.decimals) }, t.decimals)} = ${cap} atoms`
      })
      .join(', '),
    reference: `${quote.symbol} per 1 ${base.symbol} from ${url}, accepted between ${plain(minPrice, 18)} and ${plain(maxPrice, 18)}, band ${maxDeviationBps} bps`,
  }
}
