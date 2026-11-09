import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  digestOf,
  identifyKind,
  normalizeTypedData,
  normalizeUint,
  parseTypedData,
  typeSetsEqual,
  PERMIT2_ORDER_TYPES,
} from '../../src/policy/typedData.js'
import { expectOk, FIXTURES, fixture, setPath } from '../helpers.js'

const normalized = (doc: Record<string, unknown>) => expectOk(normalizeTypedData(expectOk(parseTypedData(doc))))

describe('typed data parity with Stitch', () => {
  for (const f of FIXTURES) {
    test(`${f.name} hashes to the digest the Rust code computed`, () => {
      const d = digestOf(normalized(f.typedData))
      assert.ok(d.ok)
      assert.equal(d.value, f.digest)
    })
  }

  test('kinds are identified by the exact pinned type set', () => {
    const expect: Record<string, string | null> = {
      permit2_sell_zaru_rfq: 'permit2_order',
      permit2_buy_zaru_rfq: 'permit2_order',
      permit2_buy_zaru_ladder: 'permit2_order',
      maker_session_live: 'maker_session',
      maker_session_test: 'maker_session',
      maker_enroll_live_base: 'maker_enroll',
      maker_enroll_live_bsc: 'maker_enroll',
      signer_check: 'signer_check',
      nav_attestation_v2: null,
      recall_quote: null,
    }
    for (const f of FIXTURES) {
      const raw = parseTypedData(f.typedData)
      assert.ok(raw.ok)
      assert.equal(identifyKind(raw.value), expect[f.name], f.name)
    }
  })
})

describe('type-set pinning', () => {
  test('an extra struct field, a renamed field or a domain with a version is not an order', () => {
    const extra = fixture('permit2_sell_zaru_rfq').typedData
    ;(extra['types'] as Record<string, unknown[]>)['OutputToken']?.push({ name: 'memo', type: 'string' })
    const r1 = parseTypedData(extra)
    assert.ok(r1.ok)
    assert.equal(identifyKind(r1.value), null)

    const renamed = fixture('permit2_sell_zaru_rfq').typedData
    ;((renamed['types'] as Record<string, { name: string }[]>)['OrderInfo'] as { name: string }[])[1]!.name = 'owner'
    const r2 = parseTypedData(renamed)
    assert.ok(r2.ok)
    assert.equal(identifyKind(r2.value), null)

    const versioned = fixture('permit2_sell_zaru_rfq').typedData
    ;(versioned['types'] as Record<string, unknown[]>)['EIP712Domain']?.push({ name: 'version', type: 'string' })
    setPath(versioned, 'domain.version', '1')
    const r3 = parseTypedData(versioned)
    assert.ok(r3.ok)
    assert.equal(identifyKind(r3.value), null)
  })

  test('struct order does not matter, field order does', () => {
    const reordered = Object.fromEntries(Object.entries(PERMIT2_ORDER_TYPES).reverse())
    assert.ok(typeSetsEqual(PERMIT2_ORDER_TYPES, reordered))
    const swapped = { ...PERMIT2_ORDER_TYPES, TokenPermissions: [...PERMIT2_ORDER_TYPES['TokenPermissions']!].reverse() }
    assert.ok(!typeSetsEqual(PERMIT2_ORDER_TYPES, swapped))
  })
})

describe('strict parsing', () => {
  test('top-level shape must be exactly types, primaryType, domain, message', () => {
    const doc = fixture('signer_check').typedData
    assert.ok(parseTypedData(doc).ok)
    assert.ok(!parseTypedData({ ...doc, extra: 1 }).ok)
    const { message: _m, ...missing } = doc
    assert.ok(!parseTypedData(missing).ok)
    assert.ok(!parseTypedData(null).ok)
    assert.ok(!parseTypedData([]).ok)
    assert.ok(!parseTypedData({ ...doc, types: { SignerCheck: [{ name: 'nonce', type: 'bytes32', extra: 1 }] } }).ok)
  })

  test('a struct named __proto__ is an extra type, not a new prototype', () => {
    // JSON.parse keeps `__proto__` as an own key. Copying it into a plain
    // object with `obj[name] =` would swap the prototype and hide the extra
    // struct from the pin; it has to stay visible and fail.
    const json = JSON.stringify(fixture('permit2_sell_zaru_rfq').typedData)
    const doc: unknown = JSON.parse(json.replace('"types":{', '"types":{"__proto__":[{"name":"x","type":"uint256"}],'))
    const raw = expectOk(parseTypedData(doc))
    assert.ok(Object.hasOwn(raw.types, '__proto__'))
    assert.equal(identifyKind(raw), null)
  })

  test('a message field inherited from Object.prototype does not count as present', () => {
    const doc = fixture('signer_check').typedData
    const raw = expectOk(parseTypedData(doc))
    const types = { ...raw.types, SignerCheck: [{ name: 'toString', type: 'string' }] }
    const n = normalizeTypedData({ ...raw, types, message: {} })
    assert.ok(!n.ok)
    assert.match(n.error, /toString is missing/)
  })

  test('undeclared and missing message fields are refused', () => {
    const extra = fixture('permit2_sell_zaru_rfq').typedData
    setPath(extra, 'message.witness.info.memo', 'hi')
    const r1 = parseTypedData(extra)
    assert.ok(r1.ok)
    const n1 = normalizeTypedData(r1.value)
    assert.ok(!n1.ok)
    assert.match(n1.error, /undeclared/)

    const missing = fixture('permit2_sell_zaru_rfq').typedData
    delete (((missing['message'] as Record<string, unknown>)['witness'] as Record<string, unknown>)['info'] as Record<string, unknown>)['swapper']
    const r2 = parseTypedData(missing)
    assert.ok(r2.ok)
    const n2 = normalizeTypedData(r2.value)
    assert.ok(!n2.ok)
    assert.match(n2.error, /swapper is missing/)
  })

  test('non-canonical scalar values are refused', () => {
    const cases: [string, unknown][] = [
      ['message.spender', '0x1234'],
      ['message.spender', 'eb5a29f869ff084b3fce18d3487a38a56fedc59e'],
      ['message.nonce', '-1'],
      ['message.nonce', '1.5'],
      ['message.nonce', '0x10'],
      ['message.nonce', '007'],
      ['message.nonce', 1.5],
      ['message.witness.info.additionalValidationData', '0xabc'],
      ['message.witness.outputs', 'not-an-array'],
      ['domain.chainId', '8453abc'],
    ]
    for (const [path, value] of cases) {
      const doc = setPath(fixture('permit2_sell_zaru_rfq').typedData, path, value)
      const raw = parseTypedData(doc)
      assert.ok(raw.ok)
      assert.ok(!normalizeTypedData(raw.value).ok, `${path}=${String(value)} must be refused`)
    }
    const session = setPath(fixture('maker_session_live').typedData, 'message.challenge', '0x1234')
    const raw = parseTypedData(session)
    assert.ok(raw.ok)
    assert.ok(!normalizeTypedData(raw.value).ok)
  })

  test('a long array is refused before it is decoded or hashed', () => {
    const doc = fixture('permit2_sell_zaru_rfq').typedData
    const witness = (doc['message'] as Record<string, Record<string, unknown>>)['witness'] as Record<string, unknown>
    const [output] = witness['outputs'] as unknown[]
    witness['outputs'] = Array.from({ length: 7_000 }, () => output)
    const started = performance.now()
    const n = normalizeTypedData(expectOk(parseTypedData(doc)))
    assert.ok(!n.ok)
    assert.match(n.error, /outputs has 7000 entries/)
    assert.ok(performance.now() - started < 50)
  })

  test('uints accept safe JSON integers and canonical decimal strings only', () => {
    assert.deepEqual(normalizeUint(8453), { ok: true, value: 8453n })
    assert.deepEqual(normalizeUint('0'), { ok: true, value: 0n })
    assert.ok(normalizeUint('115792089237316195423570985008687907853269984665640564039457584007913129639935').ok)
    assert.ok(!normalizeUint('115792089237316195423570985008687907853269984665640564039457584007913129639936').ok)
    assert.ok(!normalizeUint('1'.repeat(79)).ok)
    const started = performance.now()
    assert.ok(!normalizeUint('9'.repeat(1_000_000)).ok)
    assert.ok(performance.now() - started < 50, 'a huge digit string is refused without parsing it')
    assert.ok(!normalizeUint(2 ** 53).ok)
    assert.ok(!normalizeUint(-1).ok)
    assert.ok(!normalizeUint(true).ok)
    assert.ok(!normalizeUint(null).ok)
  })

  test('a chainId given as a string hashes the same as the number Stitch sends', () => {
    const asString = setPath(fixture('permit2_sell_zaru_rfq').typedData, 'domain.chainId', '8453')
    const d = digestOf(normalized(asString))
    assert.ok(d.ok)
    assert.equal(d.value, fixture('permit2_sell_zaru_rfq').digest)
  })

  test('checksummed and lower-case addresses hash the same', () => {
    const doc = setPath(fixture('permit2_sell_zaru_rfq').typedData, 'message.spender', '0xEb5A29F869FF084B3Fce18d3487a38A56feDC59E')
    const d = digestOf(normalized(doc))
    assert.ok(d.ok)
    assert.equal(d.value, fixture('permit2_sell_zaru_rfq').digest)
  })
})
