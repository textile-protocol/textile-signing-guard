// The acceptance suite: one compliant request per allowed kind, and a set of
// non-compliant ones that each break exactly one rule. Built from the same
// structures Stitch produces (`../stitch.ts`), with amounts taken from the
// live reference price so the compliant orders sit on the mid.
//
// Expectations are derived from the config under test (for example
// `signer_check` is expected to pass only when `allow.signer_check` is on),
// so the same suite serves every operator's policy.

import { zeroAddress } from 'viem'
import { CONFIG_CHANGE_ROUTE, TX_SIGN_ROUTE } from '../callback/server.js'
import { type GuardConfig, priceTokens, type TokenConfig } from '../config.js'
import type { Rational } from '../price/rational.js'
import type { Hex } from '../types.js'
import {
  approveContractCallRequest,
  buildErc2612PermitTypedData,
  buildMakerEnrollTypedData,
  buildMakerSessionTypedData,
  buildOrderTypedData,
  buildSignerCheckTypedData,
  encodePreferredFillerValidation,
  type OrderInput,
  typedMessageRequest,
} from './stitch.js'

export type Expectation =
  | { kind: 'decision'; action: 'APPROVE' | 'REJECT' | 'IGNORE'; reason?: string }
  | { kind: 'unauthenticated' }
  | { kind: 'decision'; action: 'APPROVE' | 'REJECT' | 'IGNORE'; reason?: string }
  | { kind: 'unauthenticated' }

export type AcceptanceCase = {
  id: string
  title: string
  route: string
  payload: Record<string, unknown>
  signer: 'cosigner' | 'wrong_key' | 'garbage'
  expect: Expectation
}

const UNKNOWN_TOKEN = '0x1111111111111111111111111111111111111111'
const ATTACKER = '0xbad0000000000000000000000000000000000bad'
const TAKER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const CHALLENGE: Hex = '0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const approves = (reason: string): Expectation => ({ kind: 'decision', action: 'APPROVE', reason })
const rejects = (reason: string): Expectation => ({ kind: 'decision', action: 'REJECT', reason })
const UNAUTHENTICATED: Expectation = { kind: 'unauthenticated' }

/** 100 whole tokens, or the cap if that is smaller. */
const sampleAmount = (config: GuardConfig, token: TokenConfig): bigint => {
  const cap = config.order.maxInputAmount[token.symbol] ?? 0n
  const hundred = 100n * 10n ** BigInt(token.decimals)
  return cap < hundred ? cap : hundred
}

const scale = (amount: bigint, bps: bigint): bigint => (amount * (10_000n + bps)) / 10_000n

/** `amount` of `from` converted to `to` at `mid` (quote per 1 base), floored. */
export const amountAtMid = (
  amount: bigint,
  from: TokenConfig,
  to: TokenConfig,
  mid: Rational,
  fromIsBase: boolean
): bigint => {
  const fromUnit = 10n ** BigInt(from.decimals)
  const toUnit = 10n ** BigInt(to.decimals)
  return fromIsBase
    ? (amount * mid.num * toUnit) / (mid.den * fromUnit)
    : (amount * mid.den * toUnit) / (mid.num * fromUnit)
}

export type OrderAmounts = {
  inputToken: TokenConfig
  inputAmount: bigint
  outputToken: TokenConfig
  outputAmount: bigint
}

/**
 * Amounts for an order at the reference price. `payBase` means the vault pays
 * the ticker's base token (USDC for USDCZARU) and receives the quote token.
 * `skewBps` moves the output away from the mid (negative = vault receives less).
 */
export function orderAmounts(
  config: GuardConfig,
  mid: Rational,
  payBase: boolean,
  skewBps = 0n,
  inputAmount?: bigint
): OrderAmounts {
  const { base, quote } = priceTokens(config)
  const inputToken = payBase ? base : quote
  const outputToken = payBase ? quote : base
  const input = inputAmount ?? sampleAmount(config, inputToken)
  const output = amountAtMid(input, inputToken, outputToken, mid, payBase)
  return { inputToken, inputAmount: input, outputToken, outputAmount: scale(output, skewBps) }
}

type OrderOptions = { payBase?: boolean; skewBps?: bigint; inputAmount?: bigint }

export function buildCases(config: GuardConfig, mid: Rational, nowMs: number): AcceptanceCase[] {
  const vaultId = config.vault.fireblocksVaultAccountId ?? '0'
  const nowSecs = BigInt(Math.floor(nowMs / 1000))
  const deadline = nowSecs + BigInt(Math.min(config.order.maxLifetimeSecs, 60))
  const validationContract =
    config.order.validationContracts?.[1] ?? config.order.validationContracts?.[0] ?? zeroAddress
  const validationData: Hex =
    validationContract === zeroAddress ? '0x' : encodePreferredFillerValidation([TAKER], deadline)
  const { base, quote } = priceTokens(config)
  const outOfBand = BigInt(2 * config.price.maxDeviationBps + 10)
  const farDeadline = nowSecs + BigInt(config.order.maxLifetimeSecs + config.order.clockSkewSecs + 3600)
  const baseCap = config.order.maxInputAmount[base.symbol] ?? 0n

  // The approve opt-in: the first capped token, or the base token with a
  // nominal cap when the section is absent (every approve case then expects
  // operation_not_allowed anyway).
  const approveSymbol = config.approve ? Object.keys(config.approve.maxAmount)[0] : undefined
  const approveTarget = {
    token: config.order.tokens.find((t) => t.symbol === approveSymbol) ?? base,
    cap: (approveSymbol && config.approve?.maxAmount[approveSymbol]) || 1n,
    asset: config.approve?.assetIds[0] ?? 'BASECHAIN_ETH',
  }

  let counter = 0
  const requestId = (slug: string) => `acc-${nowMs.toString(36)}-${(counter++).toString(36)}-${slug}`

  const order = (o: OrderOptions = {}): OrderInput => {
    const a = orderAmounts(config, mid, o.payBase ?? true, o.skewBps ?? 0n, o.inputAmount)
    return {
      chainId: config.chainId,
      permit2: config.order.permit2,
      reactor: config.order.reactor,
      swapper: config.venue.fundingWallet,
      recipient: config.venue.fundingWallet,
      nonce: BigInt(nowMs) * 1000n + BigInt(counter),
      deadline,
      inputToken: a.inputToken.address,
      inputAmount: a.inputAmount,
      outputToken: a.outputToken.address,
      outputAmount: a.outputAmount,
      validationContract,
      validationData,
    }
  }

  const withOutputs = (
    o: OrderInput,
    outputs: { token: string; amount: bigint; recipient: string }[]
  ): Record<string, unknown> => {
    const td = buildOrderTypedData(o) as { message: { witness: { outputs: unknown } } }
    td.message.witness.outputs = outputs.map((x) => ({
      token: x.token.toLowerCase(),
      amount: x.amount.toString(),
      recipient: x.recipient.toLowerCase(),
    }))
    return td as unknown as Record<string, unknown>
  }

  /** A `tx_sign_request` case. `payload` may be a typed-data document or a full envelope. */
  const txCase = (c: {
    id: string
    title: string
    expect: Expectation
    typedData?: unknown
    messageType?: string
    envelope?: (requestId: string) => Record<string, unknown>
    signer?: AcceptanceCase['signer']
  }): AcceptanceCase => {
    const rid = requestId(c.id)
    const payload = c.envelope
      ? c.envelope(rid)
      : typedMessageRequest(c.typedData, { requestId: rid, vaultAccountId: vaultId }, c.messageType ?? 'EIP712')
    return { id: c.id, title: c.title, route: TX_SIGN_ROUTE, payload, signer: c.signer ?? 'cosigner', expect: c.expect }
  }

  const orderCase = (
    id: string,
    title: string,
    expect: Expectation,
    typedData: unknown,
    signer?: AcceptanceCase['signer']
  ): AcceptanceCase => txCase(signer ? { id, title, expect, typedData, signer } : { id, title, expect, typedData })

  const session = (domainName: string, signingAddress: string) =>
    buildMakerSessionTypedData({
      domainName,
      makerId: 'mk_acceptance',
      signingAddress,
      challenge: CHALLENGE,
      issuedAtMs: BigInt(nowMs),
    })
  const sessionIfAllowed = (reason: string) => rejects(config.allow.makerSession ? reason : 'kind_not_allowed')
  const approveCall = (spender: string, amount: bigint) => (rid: string) =>
    approveContractCallRequest({
      requestId: rid,
      vaultAccountId: vaultId,
      asset: approveTarget.asset,
      token: approveTarget.token.address,
      spender,
      amount,
    })
  const approveIfAllowed = (reason: string) =>
    rejects(config.allow.erc20ApprovePermit2 ? reason : 'operation_not_allowed')
  const plainOp =
    (operation: string, extra: Record<string, unknown> = {}) =>
    (rid: string) => ({
      txId: rid,
      requestId: rid,
      operation,
      sourceType: 'VAULT',
      sourceId: vaultId,
      ...extra,
    })

  return [
    // --- compliant -----------------------------------------------------------
    orderCase(
      'order-pay-base',
      `Compliant order: vault pays ${base.symbol}, receives ${quote.symbol} at the reference price`,
      approves('order_compliant'),
      buildOrderTypedData(order({ payBase: true }))
    ),
    orderCase(
      'order-pay-quote',
      `Compliant order: vault pays ${quote.symbol}, receives ${base.symbol} at the reference price`,
      approves('order_compliant'),
      buildOrderTypedData(order({ payBase: false }))
    ),
    txCase({
      id: 'maker-session',
      title: `MakerSession under "${config.venue.sessionDomainName}" for the vault`,
      typedData: session(config.venue.sessionDomainName, config.vault.address),
      expect: config.allow.makerSession ? approves('session_compliant') : rejects('kind_not_allowed'),
    }),
    txCase({
      id: 'maker-enroll',
      title: `MakerEnroll under "${config.venue.enrollDomainName}" on chain ${config.chainId}`,
      typedData: buildMakerEnrollTypedData({
        domainName: config.venue.enrollDomainName,
        signingAddress: config.vault.address,
        fundingWallet: config.venue.fundingWallet,
        chainId: config.chainId,
        issuedAtMs: BigInt(nowMs),
      }),
      expect: config.allow.makerEnroll ? approves('enroll_compliant') : rejects('kind_not_allowed'),
    }),
    txCase({
      id: 'signer-check',
      title: `SignerCheck (panel Verify button); allow.signer_check is ${config.allow.signerCheck ? 'on' : 'off'}`,
      typedData: buildSignerCheckTypedData(CHALLENGE),
      expect: config.allow.signerCheck ? approves('signer_check') : rejects('kind_not_allowed'),
    }),

    // --- non-compliant orders ------------------------------------------------
    orderCase(
      'order-wrong-recipient',
      'Order output paid to an address that is not the funding wallet',
      rejects('wrong_recipient'),
      buildOrderTypedData({ ...order(), recipient: ATTACKER })
    ),
    orderCase(
      'order-extra-output',
      'Order with a second output paying an attacker',
      rejects('wrong_recipient'),
      (() => {
        const o = order()
        return withOutputs(o, [
          { token: o.outputToken, amount: o.outputAmount, recipient: o.recipient },
          { token: o.outputToken, amount: 1n, recipient: ATTACKER },
        ])
      })()
    ),
    orderCase(
      'order-two-outputs-to-vault',
      'Order with two outputs that both pay the vault (Stitch orders carry one)',
      rejects('output_count'),
      (() => {
        const o = order()
        return withOutputs(o, [
          { token: o.outputToken, amount: o.outputAmount, recipient: o.recipient },
          { token: o.outputToken, amount: 1n, recipient: o.recipient },
        ])
      })()
    ),
    orderCase(
      'order-wrong-swapper',
      'Order whose swapper is not the funding wallet',
      rejects('wrong_swapper'),
      buildOrderTypedData({ ...order(), swapper: ATTACKER })
    ),
    orderCase(
      'order-unknown-output-token',
      'Order paying out an unlisted token',
      rejects('token_not_allowed'),
      buildOrderTypedData({ ...order(), outputToken: UNKNOWN_TOKEN })
    ),
    orderCase(
      'order-unknown-input-token',
      'Order pulling an unlisted token from the vault',
      rejects('token_not_allowed'),
      buildOrderTypedData({ ...order(), inputToken: UNKNOWN_TOKEN })
    ),
    orderCase(
      'order-same-token',
      'Order with the same token on both sides',
      rejects('token_not_allowed'),
      (() => {
        const o = order()
        return buildOrderTypedData({ ...o, outputToken: o.inputToken })
      })()
    ),
    orderCase(
      'order-wrong-spender',
      'Order whose Permit2 spender is not the reactor',
      rejects('wrong_spender'),
      buildOrderTypedData({ ...order(), reactor: ATTACKER })
    ),
    orderCase(
      'order-domain-wrong-contract',
      'Permit2 domain name with a different verifyingContract',
      rejects('wrong_verifying_contract'),
      buildOrderTypedData({ ...order(), permit2: ATTACKER })
    ),
    orderCase(
      'order-domain-wrong-chain',
      'Permit2 domain on another chain id',
      rejects('wrong_chain'),
      buildOrderTypedData({ ...order(), chainId: config.chainId === 1 ? 8453 : 1 })
    ),
    orderCase(
      `order-price-low-${quote.symbol.toLowerCase()}`,
      `Vault pays ${base.symbol} and receives ${outOfBand} bps too little ${quote.symbol}`,
      rejects('price_out_of_band'),
      buildOrderTypedData(order({ payBase: true, skewBps: -outOfBand }))
    ),
    orderCase(
      `order-price-low-${base.symbol.toLowerCase()}`,
      `Vault pays ${quote.symbol} and receives ${outOfBand} bps too little ${base.symbol}`,
      rejects('price_out_of_band'),
      buildOrderTypedData(order({ payBase: false, skewBps: -outOfBand }))
    ),
    orderCase(
      'order-deadline-too-far',
      `Order deadline ${farDeadline - nowSecs}s ahead`,
      rejects('deadline_too_far'),
      buildOrderTypedData({ ...order(), deadline: farDeadline })
    ),
    orderCase(
      'order-over-cap',
      `Order pulling more ${base.symbol} than the per-order cap`,
      rejects('amount_over_cap'),
      buildOrderTypedData(order({ payBase: true, inputAmount: baseCap + 1n }))
    ),

    // --- other typed messages ------------------------------------------------
    txCase({
      id: 'eip2612-permit',
      title: `EIP-2612 permit under the ${base.symbol} token domain`,
      typedData: buildErc2612PermitTypedData({
        chainId: config.chainId,
        token: base.address,
        tokenName: base.symbol,
        owner: config.vault.address,
        spender: ATTACKER,
        value: 2n ** 256n - 1n,
        nonce: 0n,
        deadline: deadline + 86_400n,
      }),
      expect: rejects('message_kind_not_allowed'),
    }),
    txCase({
      id: 'session-wrong-domain',
      title: 'MakerSession under a domain the policy does not list',
      typedData: session(
        config.venue.sessionDomainName.includes('LIVE')
          ? config.venue.sessionDomainName.replace('LIVE', 'TEST')
          : 'Textile Maker Session (LIVE)',
        config.vault.address
      ),
      expect: sessionIfAllowed('wrong_domain'),
    }),
    txCase({
      id: 'session-wrong-signer',
      title: 'MakerSession whose signingAddress is not the vault',
      typedData: session(config.venue.sessionDomainName, ATTACKER),
      expect: sessionIfAllowed('wrong_signing_address'),
    }),
    txCase({
      id: 'eip191-message',
      title: 'EIP-191 personal message',
      typedData: '48656c6c6f',
      messageType: 'EIP191',
      expect: rejects('message_type_not_allowed'),
    }),
    txCase({
      id: 'two-messages',
      title: 'Typed message request carrying two messages',
      envelope: (rid) => {
        const td = buildOrderTypedData(order())
        const req = typedMessageRequest(td, { requestId: rid, vaultAccountId: vaultId })
        ;(req['extraParameters'] as { rawMessageData: { messages: unknown[] } }).rawMessageData.messages.push({
          content: td,
          type: 'EIP712',
          index: 1,
        })
        return req
      },
      expect: rejects('message_count'),
    }),

    // --- other operations ----------------------------------------------------
    txCase({
      id: 'raw-signing',
      title: 'RAW signing of an opaque 32-byte digest',
      envelope: plainOp('RAW', {
        asset: 'ETH',
        extraParameters: { rawMessageData: { messages: [{ content: CHALLENGE.slice(2) }] } },
      }),
      expect: rejects('operation_not_allowed'),
    }),
    txCase({
      id: 'transfer',
      title: `TRANSFER of ${base.symbol} out of the vault`,
      envelope: plainOp('TRANSFER', {
        destType: 'ONE_TIME',
        destAddress: ATTACKER,
        asset: approveTarget.asset,
        amount: 1,
        amountStr: '1',
      }),
      expect: rejects('operation_not_allowed'),
    }),
    txCase({
      id: 'unknown-operation',
      title: 'An operation type the guard has never heard of',
      envelope: plainOp('PROGRAM_CALL'),
      expect: rejects('operation_not_allowed'),
    }),
    txCase({
      id: 'approve-other-spender',
      title: 'CONTRACT_CALL approve() to a spender that is not Permit2',
      envelope: approveCall(ATTACKER, 1n),
      expect: approveIfAllowed('wrong_spender'),
    }),
    txCase({
      id: 'approve-permit2',
      title: `CONTRACT_CALL approve(Permit2) on ${approveTarget.token.symbol} within the cap; allow.erc20_approve_permit2 is ${config.allow.erc20ApprovePermit2 ? 'on' : 'off'}`,
      envelope: approveCall(config.order.permit2, approveTarget.cap),
      expect: config.allow.erc20ApprovePermit2 ? approves('approve_compliant') : rejects('operation_not_allowed'),
    }),
    txCase({
      id: 'approve-over-cap',
      title: 'CONTRACT_CALL approve(Permit2) above the cap',
      envelope: approveCall(config.order.permit2, approveTarget.cap + 1n),
      expect: approveIfAllowed('amount_over_cap'),
    }),
    {
      id: 'config-change',
      title: `Configuration change approval request (policy: ${config.configChangeAction})`,
      route: CONFIG_CHANGE_ROUTE,
      payload: { requestId: requestId('config'), type: 'ADD_API_USER', extraInfo: {} },
      signer: 'cosigner',
      expect: {
        kind: 'decision',
        action: config.configChangeAction,
        reason: config.configChangeAction === 'IGNORE' ? 'config_change_ignored' : 'config_change_rejected',
      },
    },

    // --- authentication --------------------------------------------------------
    orderCase(
      'jwt-wrong-key',
      'Compliant order signed with a key that is not the co-signer',
      UNAUTHENTICATED,
      buildOrderTypedData(order()),
      'wrong_key'
    ),
    {
      id: 'jwt-garbage',
      title: 'Request body that is not a JWT',
      route: TX_SIGN_ROUTE,
      payload: {},
      signer: 'garbage',
      expect: UNAUTHENTICATED,
    },
  ]
}
