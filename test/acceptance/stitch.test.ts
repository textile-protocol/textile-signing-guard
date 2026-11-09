import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildMakerEnrollTypedData,
  buildMakerSessionTypedData,
  buildOrderTypedData,
  buildSignerCheckTypedData,
  encodePreferredFillerValidation,
} from '../../src/acceptance/stitch.js'
import { fixture, PERMIT2, REACTOR, TAKER, USDC, VALIDATION, VAULT, ZARU } from '../helpers.js'

const NONCE = 71967512989470864093478216482306347412380097211829946307111256502388617832440n
const DEADLINE = 1_800_000_120n
const CHALLENGE = '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' as const

describe('builders reproduce the documents Stitch sends', () => {
  test('preferred-filler validation data matches rfq/order.rs', () => {
    const info = ((fixture('permit2_sell_zaru_rfq').typedData['message'] as Record<string, unknown>)['witness'] as Record<string, unknown>)['info'] as Record<string, unknown>
    assert.equal(encodePreferredFillerValidation([TAKER], DEADLINE), info['additionalValidationData'])
  })

  test('the RFQ sell order', () => {
    const built = buildOrderTypedData({
      chainId: 8453,
      permit2: PERMIT2,
      reactor: REACTOR,
      swapper: VAULT,
      recipient: VAULT,
      nonce: NONCE,
      deadline: DEADLINE,
      inputToken: ZARU,
      inputAmount: 1000n * 10n ** 18n,
      outputToken: USDC,
      outputAmount: 59_916_117n,
      validationContract: VALIDATION,
      validationData: encodePreferredFillerValidation([TAKER], DEADLINE),
    })
    assert.deepEqual(built, fixture('permit2_sell_zaru_rfq').typedData)
  })

  test('the RFQ buy order', () => {
    const built = buildOrderTypedData({
      chainId: 8453,
      permit2: PERMIT2,
      reactor: REACTOR,
      swapper: VAULT,
      recipient: VAULT,
      nonce: NONCE + 1n,
      deadline: DEADLINE,
      inputToken: USDC,
      inputAmount: 1_000_000_000n,
      outputToken: ZARU,
      outputAmount: 16_690n * 10n ** 18n,
      validationContract: VALIDATION,
      validationData: encodePreferredFillerValidation([TAKER], DEADLINE),
    })
    assert.deepEqual(built, fixture('permit2_buy_zaru_rfq').typedData)
  })

  test('the ladder order (no validation contract)', () => {
    const built = buildOrderTypedData({
      chainId: 8453,
      permit2: PERMIT2,
      reactor: REACTOR,
      swapper: VAULT,
      recipient: VAULT,
      nonce: NONCE + 2n,
      deadline: DEADLINE,
      inputToken: USDC,
      inputAmount: 500_000_000n,
      outputToken: ZARU,
      outputAmount: 8_345n * 10n ** 18n,
      validationContract: '0x0000000000000000000000000000000000000000',
      validationData: '0x',
    })
    assert.deepEqual(built, fixture('permit2_buy_zaru_ladder').typedData)
  })

  test('maker session, enroll and signer check', () => {
    assert.deepEqual(
      buildMakerSessionTypedData({ domainName: 'Textile Maker Session (LIVE)', makerId: 'mk_first_client', signingAddress: VAULT, challenge: CHALLENGE, issuedAtMs: 1_800_000_000_000n }),
      fixture('maker_session_live').typedData
    )
    assert.deepEqual(
      buildMakerEnrollTypedData({ domainName: 'Textile Maker Enroll (LIVE)', signingAddress: VAULT, fundingWallet: VAULT, chainId: 8453, issuedAtMs: 1_800_000_000_000n }),
      fixture('maker_enroll_live_base').typedData
    )
    assert.deepEqual(buildSignerCheckTypedData(CHALLENGE), fixture('signer_check').typedData)
  })
})
