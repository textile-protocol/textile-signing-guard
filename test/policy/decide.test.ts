import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { approveContractCallRequest, typedMessageRequest } from '../../src/acceptance/stitch.js'
import { parseSignRequest } from '../../src/callback/request.js'
import { decide, decideConfigChange } from '../../src/policy/decide.js'
import { ATTACKER, expectOk, fixture, NOW_MS, PERMIT2, PRICE, requestFor, testConfig, USDC, ZARU } from '../helpers.js'

const config = testConfig()
const ctx = { config, nowMs: NOW_MS, price: PRICE }
const parse = (payload: unknown) => expectOk(parseSignRequest(payload))
const sell = () => fixture('permit2_sell_zaru_rfq')

describe('operation dispatch', () => {
  test('RAW, TRANSFER, MINT and unknown operations are rejected', () => {
    for (const operation of ['RAW', 'TRANSFER', 'MINT', 'BURN', 'PROGRAM_CALL', 'typed_message', '']) {
      const payload = { ...typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' }), operation }
      const r = parseSignRequest(payload)
      if (!r.ok) {
        assert.equal(operation, '', 'only the empty operation fails to parse')
        continue
      }
      const d = decide(r.value, ctx)
      assert.equal(d.action, 'REJECT', operation)
      assert.equal(d.reason, 'operation_not_allowed', operation)
    }
  })

  test('a typed message request needs exactly one EIP712 message', () => {
    const two = typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' })
    ;(two['extraParameters'] as { rawMessageData: { messages: unknown[] } }).rawMessageData.messages.push({ content: sell().typedData, type: 'EIP712' })
    assert.equal(decide(parse(two), ctx).reason, 'message_count')

    const none = typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' })
    ;(none['extraParameters'] as { rawMessageData: { messages: unknown[] } }).rawMessageData.messages = []
    assert.equal(decide(parse(none), ctx).reason, 'message_count')

    assert.equal(decide(requestFor('48656c6c6f'), ctx).reason, 'malformed_typed_data', 'EIP712 type with hex content')
    const eip191 = parse(typedMessageRequest('48656c6c6f', { requestId: 'r', vaultAccountId: '0' }, 'EIP191'))
    assert.equal(decide(eip191, ctx).reason, 'message_type_not_allowed')

    const noExtra = { ...typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' }), extraParameters: undefined }
    assert.equal(decide(parse(noExtra), ctx).reason, 'malformed_request')
    const noMessages = { ...typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' }), extraParameters: { rawMessageData: {} } }
    assert.equal(decide(parse(noMessages), ctx).reason, 'malformed_request')
  })

  test('the request must come from the pinned vault account when one is configured', () => {
    const other = typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '7' })
    assert.equal(decide(parse(other), ctx).reason, 'wrong_source')
    const exchange = { ...typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' }), sourceType: 'EXCHANGE_ACCOUNT' }
    assert.equal(decide(parse(exchange), ctx).reason, 'wrong_source')
    const numeric = { ...typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' }), sourceId: 0 }
    assert.equal(decide(parse(numeric), ctx).action, 'APPROVE', 'a numeric vault id is the same account')
    const unpinned = testConfig((d) => {
      delete (d['vault'] as Record<string, unknown>)['fireblocks_vault_account_id']
    })
    assert.equal(decide(parse(other), { ...ctx, config: unpinned }).action, 'APPROVE')
  })
})

describe('signing payload cross-check', () => {
  const withRawTx = (payloads: string[]) => ({
    ...typedMessageRequest(sell().typedData, { requestId: 'r', vaultAccountId: '0' }),
    rawTx: payloads.map((payload) => ({ rawTx: '', keyDerivationPath: '[44,60,0,0,0]', payload })),
  })

  test('a rawTx payload equal to the EIP-712 digest passes, with or without 0x', () => {
    assert.equal(decide(parse(withRawTx([sell().digest])), ctx).action, 'APPROVE')
    assert.equal(decide(parse(withRawTx([sell().digest.slice(2).toUpperCase()])), ctx).action, 'APPROVE')
  })

  test('a rawTx payload that is not the digest of the typed data is rejected', () => {
    const d = decide(parse(withRawTx([fixture('permit2_buy_zaru_rfq').digest])), ctx)
    assert.equal(d.action, 'REJECT')
    assert.equal(d.reason, 'signing_payload_mismatch')
    assert.equal(decide(parse(withRawTx([sell().digest, fixture('signer_check').digest])), ctx).reason, 'signing_payload_mismatch')
  })

  test('a missing rawTx is tolerated by default and rejected when required', () => {
    assert.equal(decide(requestFor(sell().typedData), ctx).action, 'APPROVE')
    const strict = testConfig((d) => {
      d['signing_payload'] = { require: true }
    })
    assert.equal(decide(requestFor(sell().typedData), { ...ctx, config: strict }).reason, 'signing_payload_missing')
    assert.equal(decide(parse(withRawTx([sell().digest])), { ...ctx, config: strict }).action, 'APPROVE')
  })

  test('a malformed rawTx array is a parse failure', () => {
    assert.ok(!parseSignRequest({ ...withRawTx([]), rawTx: [{ payload: 7 }] }).ok)
    assert.ok(!parseSignRequest({ ...withRawTx([]), rawTx: 'x' }).ok)
  })
})

describe('contract calls', () => {
  const call = (p: Partial<Parameters<typeof approveContractCallRequest>[0]> = {}) =>
    approveContractCallRequest({ requestId: 'c', vaultAccountId: '0', asset: 'BASECHAIN_ETH', token: USDC, spender: PERMIT2, amount: 60_000n * 10n ** 6n, ...p })
  const on = testConfig((d) => {
    ;(d['allow'] as Record<string, unknown>)['erc20_approve_permit2'] = true
  })
  const onCtx = { ...ctx, config: on }

  test('off by default: even a perfect approve is rejected', () => {
    const d = decide(parse(call()), ctx)
    assert.equal(d.action, 'REJECT')
    assert.equal(d.reason, 'operation_not_allowed')
  })

  test('when enabled, approve(Permit2, <= cap) on an allowed token passes', () => {
    const d = decide(parse(call()), onCtx)
    assert.equal(d.action, 'APPROVE', d.detail)
    assert.equal(d.summary['token'], 'USDC')
    assert.equal(d.summary['amount'], (60_000n * 10n ** 6n).toString())
    assert.equal(decide(parse(call({ token: ZARU, amount: 1_000_000n * 10n ** 18n })), onCtx).action, 'APPROVE')
  })

  test('every other approve shape is rejected', () => {
    assert.equal(decide(parse(call({ amount: 60_000n * 10n ** 6n + 1n })), onCtx).reason, 'amount_over_cap')
    assert.equal(decide(parse(call({ spender: ATTACKER })), onCtx).reason, 'wrong_spender')
    assert.equal(decide(parse(call({ token: ATTACKER })), onCtx).reason, 'token_not_allowed')
    assert.equal(decide(parse(call({ asset: 'ETH' })), onCtx).reason, 'wrong_asset')
    assert.equal(decide(parse({ ...call(), amountStr: '0.1' }), onCtx).reason, 'native_value')
    assert.equal(decide(parse({ ...call(), amountStr: undefined }), onCtx).reason, 'native_value', 'an unstated value is not zero')
    assert.equal(decide(parse({ ...call(), amount: 5 }), onCtx).reason, 'native_value', 'amount and amountStr must both be zero')
    const transfer = { ...call(), extraParameters: { contractCallData: `0xa9059cbb${ATTACKER.slice(2).padStart(64, '0')}${'1'.padStart(64, '0')}` } }
    assert.equal(decide(parse(transfer), onCtx).reason, 'wrong_function')
    const padded = { ...call(), extraParameters: { contractCallData: `0x095ea7b3${'ff'.repeat(12)}${PERMIT2.slice(2).toLowerCase()}${'1'.padStart(64, '0')}` } }
    assert.equal(decide(parse(padded), onCtx).reason, 'malformed_call')
    const longer = { ...call(), extraParameters: { contractCallData: `${(call()['extraParameters'] as { contractCallData: string }).contractCallData}00` } }
    assert.equal(decide(parse(longer), onCtx).reason, 'malformed_call')
    assert.equal(decide(parse({ ...call(), destAddress: undefined }), onCtx).reason, 'malformed_call')
    assert.equal(decide(parse({ ...call(), extraParameters: {} }), onCtx).reason, 'malformed_call')
  })

  test('the vault-account pin applies to contract calls too', () => {
    assert.equal(decide(parse(call({ vaultAccountId: '9' })), onCtx).reason, 'wrong_source')
  })
})

describe('configuration changes', () => {
  const change = { requestId: 'cfg', type: 'ADD_USER' }
  const ignore = testConfig((d) => {
    d['config_change_action'] = 'IGNORE'
  })

  test('rejected by default, ignorable by config', () => {
    assert.equal(decideConfigChange(change, config).action, 'REJECT')
    assert.equal(decideConfigChange(change, ignore).action, 'IGNORE')
  })

  test('a transaction sent to the config-change route is rejected even when IGNORE is set', () => {
    const tx = typedMessageRequest(fixture('permit2_sell_zaru_rfq').typedData, { requestId: 'tx', vaultAccountId: '0' })
    const d = decideConfigChange(tx, ignore)
    assert.equal(d.action, 'REJECT')
    assert.match(d.detail, /is a transaction/)
  })
})

describe('request parsing', () => {
  test('requestId and operation are required; typed optional fields are checked', () => {
    assert.ok(!parseSignRequest({ operation: 'TYPED_MESSAGE' }).ok)
    assert.ok(!parseSignRequest({ requestId: 'r' }).ok)
    assert.ok(!parseSignRequest({ requestId: 'r', operation: 'TYPED_MESSAGE', extraParameters: 'x' }).ok)
    assert.ok(!parseSignRequest({ requestId: 'r', operation: 'TYPED_MESSAGE', destAddress: {} }).ok)
    assert.ok(!parseSignRequest(null).ok)
    assert.ok(!parseSignRequest([]).ok)
    assert.ok(parseSignRequest({ requestId: 'r', operation: 'X', unknownField: 1 }).ok, 'unknown top-level fields pass through')
  })
})
