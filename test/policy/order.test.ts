import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildErc2612PermitTypedData, buildOrderTypedData, encodePreferredFillerValidation } from '../../src/acceptance/stitch.js'
import { decide } from '../../src/policy/decide.js'
import type { Decision, DecisionContext } from '../../src/policy/decision.js'
import { ATTACKER, fixture, NOW_MS, PERMIT2, PRICE, REACTOR, requestFor, setPath, TAKER, testConfig, USDC, VALIDATION, VAULT, ZARU } from '../helpers.js'

const config = testConfig()
const ctx: DecisionContext = { config, nowMs: NOW_MS, price: PRICE }
const run = (doc: Record<string, unknown>, c = ctx): Decision => decide(requestFor(doc), c)
const sell = () => fixture('permit2_sell_zaru_rfq').typedData
const buy = () => fixture('permit2_buy_zaru_rfq').typedData
type Out = { token: string; amount: string; recipient: string }
const outputs = (doc: Record<string, unknown>): Out[] =>
  ((doc['message'] as Record<string, unknown>)['witness'] as Record<string, unknown>)['outputs'] as Out[]

describe('compliant orders', () => {
  test('the three fixture orders are approved with an audit summary', () => {
    for (const name of ['permit2_sell_zaru_rfq', 'permit2_buy_zaru_rfq', 'permit2_buy_zaru_ladder']) {
      const d = run(fixture(name).typedData)
      assert.equal(d.action, 'APPROVE', `${name}: ${d.detail}`)
      assert.equal(d.reason, 'order_compliant')
      assert.equal(d.summary['kind'], 'permit2_order')
      assert.equal(d.summary['digest'], fixture(name).digest)
      assert.equal(d.summary['swapper'], VAULT)
      assert.equal(d.summary['referencePrice'], '16.690000')
      assert.ok(typeof d.summary['deviationBps'] === 'number' && Math.abs(d.summary['deviationBps']) <= 1, name)
    }
    assert.equal(run(sell()).summary['direction'], 'pay ZARU, receive USDC')
    assert.equal(run(buy()).summary['direction'], 'pay USDC, receive ZARU')
  })
})

describe('recipient and swapper', () => {
  test('one wrong recipient among several outputs is rejected for the recipient', () => {
    const doc = sell()
    const [first] = outputs(doc) as [Out]
    outputs(doc).push({ token: first.token, amount: '1', recipient: ATTACKER })
    const d = run(doc)
    assert.equal(d.action, 'REJECT')
    assert.equal(d.reason, 'wrong_recipient')
  })

  test('an extra output to the vault is still rejected: Stitch orders carry one', () => {
    const doc = sell()
    const [first] = outputs(doc) as [Out]
    outputs(doc).push({ ...first, amount: '1' })
    assert.equal(run(doc).reason, 'output_count')
  })

  test('no outputs is rejected', () => {
    const doc = setPath(sell(), 'message.witness.outputs', [])
    assert.equal(run(doc).reason, 'output_count')
  })

  test('the single recipient must be the vault', () => {
    const doc = sell()
    outputs(doc)[0]!.recipient = ATTACKER
    assert.equal(run(doc).reason, 'wrong_recipient')
  })

  test('the swapper must be the vault', () => {
    assert.equal(run(setPath(sell(), 'message.witness.info.swapper', ATTACKER)).reason, 'wrong_swapper')
  })
})

describe('tokens', () => {
  test('an unlisted output token is rejected', () => {
    const doc = sell()
    outputs(doc)[0]!.token = '0x1111111111111111111111111111111111111111'
    assert.equal(run(doc).reason, 'token_not_allowed')
  })

  test('an unlisted input token is rejected even when permitted.token matches it', () => {
    const doc = setPath(sell(), 'message.permitted.token', '0x1111111111111111111111111111111111111111')
    setPath(doc, 'message.witness.inputToken', '0x1111111111111111111111111111111111111111')
    assert.equal(run(doc).reason, 'token_not_allowed')
  })

  test('the same token on both sides is rejected', () => {
    const doc = sell()
    outputs(doc)[0]!.token = ZARU.toLowerCase()
    assert.equal(run(doc).reason, 'token_not_allowed')
  })

  test('permit and witness must agree on token, amount, nonce and deadline', () => {
    assert.equal(run(setPath(sell(), 'message.permitted.token', USDC.toLowerCase())).reason, 'permit_witness_mismatch')
    assert.equal(run(setPath(sell(), 'message.permitted.amount', '1')).reason, 'permit_witness_mismatch')
    assert.equal(run(setPath(sell(), 'message.nonce', '1')).reason, 'permit_witness_mismatch')
    assert.equal(run(setPath(sell(), 'message.deadline', '1800000119')).reason, 'permit_witness_mismatch')
  })
})

describe('domain and spender', () => {
  test('EIP-2612 permit under the token domain is not an allowed kind', () => {
    const permit = buildErc2612PermitTypedData({ chainId: 8453, token: USDC, tokenName: 'USD Coin', owner: VAULT, spender: ATTACKER, value: 2n ** 256n - 1n, nonce: 0n, deadline: 1_900_000_000n })
    const d = run(permit)
    assert.equal(d.action, 'REJECT')
    assert.equal(d.reason, 'message_kind_not_allowed')
    assert.equal(d.summary['primaryType'], 'Permit')
  })

  test('Permit2 name with another verifyingContract is rejected', () => {
    assert.equal(run(setPath(sell(), 'domain.verifyingContract', ATTACKER)).reason, 'wrong_verifying_contract')
  })

  test('Permit2 on another chain is rejected', () => {
    assert.equal(run(setPath(sell(), 'domain.chainId', 1)).reason, 'wrong_chain')
    assert.equal(run(setPath(sell(), 'domain.chainId', 84532)).reason, 'wrong_chain')
  })

  test('a different domain name is rejected', () => {
    assert.equal(run(setPath(sell(), 'domain.name', 'Permit3')).reason, 'wrong_domain')
  })

  test('a spender other than the reactor is rejected, and so is a witness reactor that differs', () => {
    assert.equal(run(setPath(sell(), 'message.spender', ATTACKER)).reason, 'wrong_spender')
    assert.equal(run(setPath(sell(), 'message.witness.info.reactor', ATTACKER)).reason, 'wrong_reactor')
  })

  test('a validation contract outside the allowlist is rejected; the check is off when unconfigured', () => {
    const doc = setPath(sell(), 'message.witness.info.additionalValidationContract', ATTACKER)
    assert.equal(run(doc).reason, 'validation_contract_not_allowed')
    const open = testConfig((d) => {
      delete (d['order'] as Record<string, unknown>)['validation_contracts']
    })
    assert.equal(run(doc, { ...ctx, config: open }).action, 'APPROVE')
  })
})

describe('price band', () => {
  const order = (inputAmount: bigint, outputAmount: bigint, payUsdc: boolean) =>
    buildOrderTypedData({
      chainId: 8453,
      permit2: PERMIT2,
      reactor: REACTOR,
      swapper: VAULT,
      recipient: VAULT,
      nonce: 1n,
      deadline: 1_800_000_120n,
      inputToken: payUsdc ? USDC : ZARU,
      inputAmount,
      outputToken: payUsdc ? ZARU : USDC,
      outputAmount,
      validationContract: VALIDATION,
      validationData: encodePreferredFillerValidation([TAKER], 1_800_000_120n),
    })

  // Reference 16.69 ZARU per USDC, band 50 bps. Paying 1000 USDC, the vault
  // should receive 16690 ZARU; 50 bps less is 16606.55 ZARU exactly.
  const ONE_K_USDC = 1_000_000_000n
  const EDGE_ZARU = 16_606_550_000_000_000_000_000n

  test('buying ZARU: exactly 50 bps under is inside, one wei less is outside', () => {
    assert.equal(run(order(ONE_K_USDC, EDGE_ZARU, true)).action, 'APPROVE')
    const d = run(order(ONE_K_USDC, EDGE_ZARU - 1n, true))
    assert.equal(d.reason, 'price_out_of_band')
    assert.equal(d.summary['deviationBps'], -50)
  })

  test('buying ZARU: receiving far too much is also outside a symmetric band', () => {
    assert.equal(run(order(ONE_K_USDC, 17_000n * 10n ** 18n, true)).reason, 'price_out_of_band')
    assert.equal(run(order(ONE_K_USDC, 16_773_450_000_000_000_000_000n, true)).action, 'APPROVE', '+50 bps is inside')
    assert.equal(run(order(ONE_K_USDC, 16_773_450_000_000_000_000_001n, true)).reason, 'price_out_of_band')
  })

  // Paying 1000 ZARU the vault should receive 59.916117 USDC. The band is on
  // the implied ZARU/USDC price, so the USDC floor is 1e9 / 16.77345 atoms =
  // 59,618,027.3: 59.618028 USDC is inside, 59.618027 is outside.
  test('selling ZARU: the band applies in the other direction too', () => {
    const ONE_K_ZARU = 1000n * 10n ** 18n
    assert.equal(run(order(ONE_K_ZARU, 59_618_028n, false)).action, 'APPROVE')
    const d = run(order(ONE_K_ZARU, 59_618_027n, false))
    assert.equal(d.reason, 'price_out_of_band')
    assert.equal(d.summary['deviationBps'], 50)
    assert.equal(run(order(ONE_K_ZARU, 50_000_000n, false)).reason, 'price_out_of_band', 'badly underpaid')
    assert.equal(run(order(ONE_K_ZARU, 70_000_000n, false)).reason, 'price_out_of_band', 'overpaid is still out of band')
  })

  test('a stale or missing reference price rejects every order', () => {
    const oldFetch = { ...PRICE, fetchedAtMs: NOW_MS - 61_000 }
    assert.equal(run(sell(), { ...ctx, price: oldFetch }).reason, 'price_stale')
    const oldSource = { ...PRICE, priceTimestampMs: NOW_MS - 601_000 }
    assert.equal(run(sell(), { ...ctx, price: oldSource }).reason, 'price_stale')
    assert.equal(run(sell(), { ...ctx, price: null }).reason, 'price_unavailable')
    const freshFetch = { ...PRICE, fetchedAtMs: NOW_MS - 60_000 }
    assert.equal(run(sell(), { ...ctx, price: freshFetch }).action, 'APPROVE', 'exactly max_age is still fresh')
    const laggingSource = { ...PRICE, priceTimestampMs: NOW_MS - 600_000 }
    assert.equal(run(sell(), { ...ctx, price: laggingSource }).action, 'APPROVE', 'exactly max_source_age is still fresh')
  })

  test('tiny amounts cannot sneak through the band via rounding', () => {
    assert.equal(run(order(1n, 1n, true)).reason, 'price_out_of_band')
    assert.equal(run(setPath(sell(), 'message.permitted.amount', '0')).reason, 'permit_witness_mismatch')
    const zero = setPath(setPath(sell(), 'message.permitted.amount', '0'), 'message.witness.inputAmount', '0')
    assert.equal(run(zero).reason, 'zero_amount')
  })
})

describe('deadline and size', () => {
  test('a deadline beyond lifetime plus skew is rejected; the edge is inside', () => {
    const nowSecs = NOW_MS / 1000
    const edge = String(nowSecs + 180 + 10)
    const edged = setPath(setPath(sell(), 'message.deadline', edge), 'message.witness.info.deadline', edge)
    assert.equal(run(edged).action, 'APPROVE')
    const over = String(nowSecs + 180 + 11)
    const tooFar = setPath(setPath(sell(), 'message.deadline', over), 'message.witness.info.deadline', over)
    assert.equal(run(tooFar).reason, 'deadline_too_far')
  })

  test('an already-expired order is rejected', () => {
    const past = String(NOW_MS / 1000)
    const doc = setPath(setPath(sell(), 'message.deadline', past), 'message.witness.info.deadline', past)
    assert.equal(run(doc).reason, 'deadline_passed')
  })

  test('permitted.amount above the per-token cap is rejected; the cap itself passes', () => {
    const cap = 500_000n * 10n ** 18n
    const atCap = setPath(setPath(sell(), 'message.permitted.amount', cap.toString()), 'message.witness.inputAmount', cap.toString())
    // Keep the price on the mid: 500000 / 16.69 USDC.
    outputs(atCap)[0]!.amount = ((cap * 100n * 10n ** 6n) / (1669n * 10n ** 18n)).toString()
    assert.equal(run(atCap).action, 'APPROVE', run(atCap).detail)
    const over = setPath(setPath(sell(), 'message.permitted.amount', (cap + 1n).toString()), 'message.witness.inputAmount', (cap + 1n).toString())
    outputs(over)[0]!.amount = (((cap + 1n) * 100n * 10n ** 6n) / (1669n * 10n ** 18n)).toString()
    assert.equal(run(over).reason, 'amount_over_cap')
  })

  test('the USDC cap applies when the vault pays USDC', () => {
    const cap = 30_000n * 10n ** 6n
    const over = setPath(setPath(buy(), 'message.permitted.amount', (cap + 1n).toString()), 'message.witness.inputAmount', (cap + 1n).toString())
    outputs(over)[0]!.amount = (((cap + 1n) * 1669n * 10n ** 18n) / (100n * 10n ** 6n)).toString()
    assert.equal(run(over).reason, 'amount_over_cap')
  })
})

describe('order ownership', () => {
  // Orders are bound to venue.funding_wallet, which the config pins to the
  // vault until OperatorVault setups (and their NavAttestation messages) are
  // part of the policy. The rule reads the funding wallet so that change is
  // confined to config.ts.
  test('the funding wallet is the vault, and the vault owns the orders', () => {
    assert.equal(config.venue.fundingWallet, VAULT)
    assert.equal(run(sell()).action, 'APPROVE')
    const other = '0x9999999999999999999999999999999999999999'
    const doc = setPath(sell(), 'message.witness.info.swapper', other)
    outputs(doc)[0]!.recipient = other
    assert.equal(run(doc).reason, 'wrong_swapper')
  })
})

describe('policy switches', () => {
  test('orders can be disabled outright', () => {
    const off = testConfig((d) => {
      ;(d['allow'] as Record<string, unknown>)['permit2_orders'] = false
    })
    assert.equal(run(sell(), { ...ctx, config: off }).reason, 'kind_not_allowed')
  })

  test('rule order: the first failing rule names the reason', () => {
    // Wrong chain and wrong recipient: domain is checked first.
    const doc = setPath(sell(), 'domain.chainId', 1)
    outputs(doc)[0]!.recipient = ATTACKER
    assert.equal(run(doc).reason, 'wrong_chain')
  })
})
