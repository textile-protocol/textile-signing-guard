import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { describeConfig, loadConfigFile, parseConfig, parseDecimalToAtomic } from '../src/config.js'
import { baseConfigDoc, section, testConfig } from './helpers.js'

type Doc = Record<string, unknown>
const expectError = (patch: (doc: Doc) => void, pattern: RegExp) => {
  const doc = baseConfigDoc()
  patch(doc)
  const r = parseConfig(doc)
  assert.ok(!r.ok, 'config must be refused')
  assert.match(r.error, pattern)
}

describe('config', () => {
  test('the shipped example parses', () => {
    const r = loadConfigFile(new URL('../../config/guard.example.json', import.meta.url).pathname)
    assert.ok(r.ok, r.ok ? '' : r.error)
    assert.equal(r.value.config.chainId, 8453)
    assert.equal(r.value.config.allow.signerCheck, false)
    assert.equal(r.value.config.allow.erc20ApprovePermit2, false)
    assert.match(r.value.sha256, /^[0-9a-f]{64}$/)
  })

  test('the quickstart config is the example policy, listening for Caddy', () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Doc
    const example = read('../../config/guard.example.json')
    const quickstart = read('../../quickstart/config/guard.json')
    assert.ok(parseConfig(quickstart).ok)
    const policy = ({ listen: _l, keys: _k, ...rest }: Doc) => rest
    assert.deepEqual(policy(quickstart), policy(example), 'only listen and keys may differ')
    assert.deepEqual(quickstart['listen'], { host: '0.0.0.0', port: 8080, plain_http: true })
  })

  test('the quickstart runs the image of this version', () => {
    const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
    const compose = readFileSync(new URL('../../quickstart/docker-compose.yml', import.meta.url), 'utf8')
    assert.match(compose, new RegExp(`image: ghcr\\.io/textile-protocol/textile-signing-guard:${version.replaceAll('.', '\\.')}\\n`))
  })

  test('amounts are converted to atomic units with the token decimals', () => {
    const cfg = testConfig()
    assert.equal(cfg.order.maxInputAmount['ZARU'], 500_000n * 10n ** 18n)
    assert.equal(cfg.order.maxInputAmount['USDC'], 30_000n * 10n ** 6n)
    assert.deepEqual(parseDecimalToAtomic('6000.50', 6, 'x'), { ok: true, value: 6_000_500_000n })
    assert.ok(!parseDecimalToAtomic('6000.1234567', 6, 'x').ok, 'too many fractional digits')
    assert.ok(!parseDecimalToAtomic('0', 6, 'x').ok)
    assert.ok(!parseDecimalToAtomic(6000, 6, 'x').ok, 'numbers are refused')
    assert.ok(!parseDecimalToAtomic('1e3', 6, 'x').ok)
  })

  test('unknown keys anywhere are refused', () => {
    expectError((d) => { d['extra'] = 1 }, /unknown keys: extra/)
    expectError((d) => { section(d, 'order')['maxInputAmount'] = {} }, /order: unknown keys/)
    expectError((d) => { section(d, 'price')['source'] = 'luno' }, /price: unknown keys/)
  })

  test('missing or malformed sections are refused', () => {
    expectError((d) => { delete d['order'] }, /order/)
    expectError((d) => { delete d['price'] }, /price/)
    expectError((d) => { section(d, 'vault')['address'] = '0x1234' }, /vault.address/)
    expectError((d) => { section(d, 'order')['reactor'] = 'not-an-address' }, /order.reactor/)
    expectError((d) => { d['chain_id'] = '8453' }, /chain_id/)
    expectError((d) => { d['chain_id'] = 0 }, /chain_id/)
  })

  test('tokens must be exactly two distinct entries with decimals', () => {
    expectError((d) => { section(d, 'order')['tokens'] = [] }, /exactly two tokens/)
    expectError((d) => { (section(d, 'order')['tokens'] as Doc[]).push({ symbol: 'X', address: '0x1111111111111111111111111111111111111111', decimals: 6 }) }, /exactly two tokens/)
    expectError((d) => { (section(d, 'order')['tokens'] as Doc[])[1]!['address'] = (section(d, 'order')['tokens'] as Doc[])[0]!['address'] }, /addresses must differ/)
    expectError((d) => { delete (section(d, 'order')['tokens'] as Doc[])[0]!['decimals'] }, /decimals/)
    expectError((d) => { delete (section(d, 'order')['max_input_amount'] as Doc)['USDC'] }, /missing an amount for USDC/)
  })

  test('price settings are cross-checked', () => {
    expectError((d) => { section(d, 'price')['base_token'] = 'USDT' }, /base_token and quote_token/)
    expectError((d) => { section(d, 'price')['quote_token'] = 'USDC' }, /base_token and quote_token/)
    expectError((d) => { section(d, 'price')['refresh_secs'] = 60 }, /refresh_secs must be smaller/)
    expectError((d) => { section(d, 'price')['max_deviation_bps'] = 0 }, /max_deviation_bps/)
    expectError((d) => { section(d, 'price')['max_deviation_bps'] = 10_000 }, /max_deviation_bps/)
    expectError((d) => { section(d, 'price')['max_spread_bps'] = 0 }, /max_spread_bps/)
    expectError((d) => { delete section(d, 'price')['min_price'] }, /price\.min_price/)
    expectError((d) => { section(d, 'price')['max_price'] = 24 }, /price\.max_price/)
    expectError((d) => { section(d, 'price')['min_price'] = '0' }, /price\.min_price/)
    expectError((d) => { section(d, 'price')['min_price'] = '24' }, /must be below/)
    expectError((d) => { section(d, 'price')['url'] = 'http://api.luno.com/api/1/ticker?pair=USDCZARU' }, /https/)
    expectError((d) => { section(d, 'price')['url'] = 'https://' }, /https/)
    expectError((d) => { section(d, 'price')['url'] = 'HTTP://api.luno.com/' }, /https/)
  })

  test('listening needs TLS or an explicit plain-HTTP opt-in, never both', () => {
    expectError((d) => { d['listen'] = { host: '0.0.0.0', port: 8443 } }, /requires HTTPS/)
    expectError((d) => { d['listen'] = { host: '0.0.0.0', port: 8443, plain_http: true, tls: { cert_file: 'a', key_file: 'b' } } }, /not both/)
    expectError((d) => { d['listen'] = { host: '0.0.0.0', port: 8443, tls: { cert_file: 'a' } } }, /key_file/)
    expectError((d) => { d['listen'] = { host: '0.0.0.0', port: 70_000, plain_http: true } }, /port/)
  })

  test('an OperatorVault funding wallet is refused until NavAttestation is in the policy', () => {
    expectError((d) => { section(d, 'venue')['funding_wallet'] = '0x9999999999999999999999999999999999999999' }, /OperatorVault setups are not supported yet/)
    const same = testConfig((d) => { section(d, 'venue')['funding_wallet'] = section(d, 'vault')['address'] })
    assert.equal(same.venue.fundingWallet, same.vault.address, 'spelling the vault out is fine')
  })

  test('the approve opt-in needs its section, and the config-change action is an enum', () => {
    expectError((d) => {
      section(d, 'allow')['erc20_approve_permit2'] = true
      delete d['approve']
    }, /approve section is missing/)
    expectError((d) => {
      section(d, 'allow')['erc20_approve_permit2'] = true
      delete section(d, 'vault')['fireblocks_vault_account_id']
    }, /needs vault\.fireblocks_vault_account_id/)
    expectError((d) => { section(d, 'approve')['asset_ids'] = [] }, /asset_ids/)
    expectError((d) => { d['config_change_action'] = 'APPROVE' }, /config_change_action/)
    expectError((d) => { section(d, 'allow')['signer_check'] = 'yes' }, /allow.signer_check/)
  })

  test('defaults are applied for the optional knobs', () => {
    const cfg = testConfig((d) => {
      delete section(d, 'price')['max_age_secs']
      delete section(d, 'price')['refresh_secs']
      delete section(d, 'price')['timeout_ms']
      delete section(d, 'venue')['max_issued_at_skew_secs']
      delete d['approve']
    })
    assert.equal(cfg.price.maxAgeSecs, 60)
    assert.equal(cfg.price.maxSpreadBps, 300)
    assert.equal(cfg.price.maxSourceAgeSecs, 600)
    assert.equal(cfg.price.refreshSecs, 5)
    assert.equal(cfg.price.timeoutMs, 3000)
    assert.equal(cfg.venue.maxIssuedAtSkewSecs, 300)
    assert.equal(cfg.venue.fundingWallet, cfg.vault.address)
    assert.equal(cfg.signingPayload.require, false)
    assert.equal(cfg.configChangeAction, 'REJECT')
    assert.equal(cfg.jwt.clockSkewSecs, 60)
    assert.equal(cfg.approve, null)
  })

  test('the summary spells out decimals, caps in atoms and the price orientation', () => {
    const d = describeConfig(testConfig())
    assert.match(d['tokens'] ?? '', /USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \(6 decimals\)/)
    assert.match(d['orderCaps'] ?? '', /USDC 30000 = 30000000000 atoms/)
    assert.match(d['orderCaps'] ?? '', /ZARU 500000 = 500000000000000000000000 atoms/)
    assert.match(d['reference'] ?? '', /^ZARU per 1 USDC from https:\/\/api\.luno\.com\S+, accepted between 12 and 24, band 50 bps$/)
  })

  test('a missing or unreadable file is an error, not a default', () => {
    assert.ok(!loadConfigFile('/nonexistent/guard.json').ok)
  })
})
