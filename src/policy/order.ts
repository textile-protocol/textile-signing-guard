// Permit2 `PermitWitnessTransferFrom` orders: the one message kind that moves
// funds, so it carries every rule in the Guard Policy. Checks run in a fixed
// order and the first failure wins; the reason code names the rule.
//
// What a passing order means: the reactor pulls `permitted.amount` of one
// configured token from the funding wallet via Permit2, and pays the single
// output, in the other configured token, back to that same wallet, at a price
// within the band of the operator's reference, with an expiry inside the
// quote lifetime. Nothing else is signable as an order.
//
// The funding wallet is `venue.funding_wallet`. Config requires it to equal
// the vault today. It would differ when the Fireblocks key is the strategy
// signer of an OperatorVault: Stitch then makes the OperatorVault the swapper
// and recipient (`src/rfq/order.rs` `build_order`), and the signer never
// appears in the order.

import { type GuardConfig, priceTokens, type TokenConfig, tokenByAddress } from '../config.js'
import { deviationBps, formatRational, impliedPrice, type Rational, withinBps } from '../price/rational.js'
import { type PriceSnapshot, staleness } from '../price/reference.js'
import { approve, type Decision, type DecisionContext, reject } from './decision.js'
import { asArray, asBigint, asString, asStruct, type NormalizedTypedData, sameAddress } from './typedData.js'

/** The order fields the policy reads, decoded once. */
type Order = {
  domainName: string
  domainChainId: bigint
  domainVerifyingContract: string
  permittedToken: string
  permittedAmount: bigint
  spender: string
  nonce: bigint
  deadline: bigint
  reactor: string
  swapper: string
  infoNonce: bigint
  infoDeadline: bigint
  validationContract: string
  validationData: string
  inputToken: string
  inputAmount: bigint
  outputs: { token: string; amount: bigint; recipient: string }[]
}

/**
 * Project the normalized document onto `Order`. `identifyKind` pinned the type
 * set and `normalizeTypedData` decoded every field, so a null here cannot
 * happen for a request that reached this point; the check stays so this
 * module does not depend on that ordering.
 */
const decode = (td: NormalizedTypedData): Order | null => {
  const permitted = asStruct(td.message['permitted'])
  const witness = asStruct(td.message['witness'])
  const info = witness ? asStruct(witness['info']) : null
  const outputs = witness ? asArray(witness['outputs']) : null
  if (!permitted || !witness || !info || !outputs) return null
  const decodedOutputs: Order['outputs'] = []
  for (const o of outputs) {
    const s = asStruct(o)
    const token = s ? asString(s['token']) : null
    const amount = s ? asBigint(s['amount']) : null
    const recipient = s ? asString(s['recipient']) : null
    if (token === null || amount === null || recipient === null) return null
    decodedOutputs.push({ token, amount, recipient })
  }
  const fields = {
    domainName: asString(td.domain['name']),
    domainChainId: asBigint(td.domain['chainId']),
    domainVerifyingContract: asString(td.domain['verifyingContract']),
    permittedToken: asString(permitted['token']),
    permittedAmount: asBigint(permitted['amount']),
    spender: asString(td.message['spender']),
    nonce: asBigint(td.message['nonce']),
    deadline: asBigint(td.message['deadline']),
    reactor: asString(info['reactor']),
    swapper: asString(info['swapper']),
    infoNonce: asBigint(info['nonce']),
    infoDeadline: asBigint(info['deadline']),
    validationContract: asString(info['additionalValidationContract']),
    validationData: asString(info['additionalValidationData']),
    inputToken: asString(witness['inputToken']),
    inputAmount: asBigint(witness['inputAmount']),
  }
  if (Object.values(fields).some((v) => v === null)) return null
  return { ...(fields as { [K in keyof typeof fields]: NonNullable<(typeof fields)[K]> }), outputs: decodedOutputs }
}

const summarize = (o: Order, extra: Decision['summary'] = {}): Decision['summary'] => ({
  spender: o.spender,
  swapper: o.swapper,
  inputToken: o.inputToken,
  inputAmount: o.inputAmount.toString(),
  outputToken: o.outputs[0]?.token ?? null,
  outputAmount: o.outputs[0]?.amount.toString() ?? null,
  outputCount: o.outputs.length,
  recipient: o.outputs[0]?.recipient ?? null,
  nonce: o.nonce.toString(),
  deadline: Number(o.deadline),
  validationContract: o.validationContract,
  ...extra,
})

/** The order's implied price in the ticker's orientation (quote per 1 base). */
type Pricing = { implied: Rational; deviation: bigint; base: TokenConfig; quote: TokenConfig }

const pricingOf = (o: Order, config: GuardConfig, mid: Rational): Pricing | null => {
  const { base, quote } = priceTokens(config)
  const output = o.outputs[0]
  if (!output) return null
  const sides = [
    { token: o.inputToken, amount: o.inputAmount },
    { token: output.token, amount: output.amount },
  ]
  const baseSide = sides.find((s) => sameAddress(s.token, base.address))
  const quoteSide = sides.find((s) => sameAddress(s.token, quote.address))
  if (!baseSide || !quoteSide) return null
  const implied = impliedPrice(quoteSide.amount, quote.decimals, baseSide.amount, base.decimals)
  if (!implied.ok) return null
  return { implied: implied.value, deviation: deviationBps(implied.value, mid), base, quote }
}

const priceFields = (p: Pricing, price: PriceSnapshot): Decision['summary'] => ({
  impliedPrice: formatRational(p.implied),
  referencePrice: price.display,
  deviationBps: Number(p.deviation),
})

type Rule = (o: Order, ctx: DecisionContext) => Decision | null

const domainRule: Rule = (o, { config }) => {
  if (o.domainName !== 'Permit2') return reject('wrong_domain', `domain name is ${JSON.stringify(o.domainName)}, not Permit2`)
  if (o.domainChainId !== BigInt(config.chainId)) {
    return reject('wrong_chain', `domain chainId is ${o.domainChainId}, policy is chain ${config.chainId}`)
  }
  if (!sameAddress(o.domainVerifyingContract, config.order.permit2)) {
    return reject('wrong_verifying_contract', `domain verifyingContract ${o.domainVerifyingContract} is not Permit2 ${config.order.permit2}`)
  }
  return null
}

const spenderRule: Rule = (o, { config }) => {
  if (!sameAddress(o.spender, config.order.reactor)) {
    return reject('wrong_spender', `spender ${o.spender} is not the reactor ${config.order.reactor}`)
  }
  if (!sameAddress(o.reactor, config.order.reactor)) {
    return reject('wrong_reactor', `witness.info.reactor ${o.reactor} is not the reactor ${config.order.reactor}`)
  }
  return null
}

/** The permit and the witness describe one order; Stitch always writes them equal. */
const consistencyRule: Rule = (o) => {
  const mismatch = (detail: string) => reject('permit_witness_mismatch', detail)
  if (!sameAddress(o.permittedToken, o.inputToken)) return mismatch('permitted.token differs from witness.inputToken')
  if (o.permittedAmount !== o.inputAmount) return mismatch('permitted.amount differs from witness.inputAmount')
  if (o.nonce !== o.infoNonce) return mismatch('nonce differs from witness.info.nonce')
  if (o.deadline !== o.infoDeadline) return mismatch('deadline differs from witness.info.deadline')
  return null
}

/** Both ends of the order are the funding wallet: the funds leave it and the proceeds return to it. */
const recipientRule: Rule = (o, { config }) => {
  const owner = config.venue.fundingWallet
  if (!sameAddress(o.swapper, owner)) {
    return reject('wrong_swapper', `witness.info.swapper ${o.swapper} is not the funding wallet ${owner}`)
  }
  const bad = o.outputs.find((out) => !sameAddress(out.recipient, owner))
  if (bad) return reject('wrong_recipient', `an output pays ${bad.recipient}, not the funding wallet ${owner}`)
  return null
}

const outputCountRule: Rule = (o) =>
  o.outputs.length === 1 ? null : reject('output_count', `order has ${o.outputs.length} outputs; Stitch orders carry exactly one`)

const tokenRule: Rule = (o, { config }) => {
  const input = tokenByAddress(config, o.inputToken)
  if (!input) return reject('token_not_allowed', `input token ${o.inputToken} is not on the allowlist`)
  const output = o.outputs[0]
  if (!output) return reject('output_count', 'order has no output')
  const out = tokenByAddress(config, output.token)
  if (!out) return reject('token_not_allowed', `output token ${output.token} is not on the allowlist`)
  if (input.symbol === out.symbol) return reject('token_not_allowed', `input and output are both ${input.symbol}`)
  if (o.inputAmount <= 0n || output.amount <= 0n) return reject('zero_amount', 'input and output amounts must be positive')
  return null
}

const validationContractRule: Rule = (o, { config }) => {
  const allowed = config.order.validationContracts
  if (allowed === null) return null
  return allowed.some((a) => sameAddress(a, o.validationContract))
    ? null
    : reject('validation_contract_not_allowed', `additionalValidationContract ${o.validationContract} is not on the allowlist`)
}

/** `tokenRule` already put the input on the allowlist, and config requires a cap per token; the null branch is defensive. */
const sizeRule: Rule = (o, { config }) => {
  const input = tokenByAddress(config, o.inputToken)
  const cap = input ? config.order.maxInputAmount[input.symbol] : undefined
  if (!input || cap === undefined) return reject('token_not_allowed', 'no size cap configured for the input token')
  return o.permittedAmount <= cap
    ? null
    : reject('amount_over_cap', `permitted.amount ${o.permittedAmount} ${input.symbol} atoms exceeds the cap ${cap}`)
}

const deadlineRule: Rule = (o, { config, nowMs }) => {
  const nowSecs = BigInt(Math.floor(nowMs / 1000))
  const latest = nowSecs + BigInt(config.order.maxLifetimeSecs + config.order.clockSkewSecs)
  if (o.deadline > latest) {
    return reject('deadline_too_far', `deadline ${o.deadline} is more than ${config.order.maxLifetimeSecs}s (+${config.order.clockSkewSecs}s skew) ahead of now ${nowSecs}`)
  }
  if (o.deadline <= nowSecs) return reject('deadline_passed', `deadline ${o.deadline} is not in the future (now ${nowSecs})`)
  return null
}

const priceRule: Rule = (o, { config, nowMs, price }) => {
  if (!price) return reject('price_unavailable', 'no reference price has been fetched yet')
  const stale = staleness(price, nowMs, config.price)
  if (stale) return reject('price_stale', stale)
  const pricing = pricingOf(o, config, price.mid)
  if (!pricing) return reject('token_not_allowed', 'order tokens do not match the price pair')
  if (!withinBps(pricing.implied, price.mid, config.price.maxDeviationBps)) {
    return reject(
      'price_out_of_band',
      `implied price ${formatRational(pricing.implied)} ${pricing.quote.symbol}/${pricing.base.symbol} is ${pricing.deviation} bps from reference ${price.display} (limit ${config.price.maxDeviationBps} bps)`,
      priceFields(pricing, price)
    )
  }
  return null
}

const RULES: Rule[] = [
  domainRule,
  spenderRule,
  consistencyRule,
  recipientRule,
  outputCountRule,
  tokenRule,
  validationContractRule,
  sizeRule,
  deadlineRule,
  priceRule,
]

/** Audit-friendly direction label: which configured token the vault pays. */
const direction = (o: Order, config: GuardConfig): string => {
  const input = tokenByAddress(config, o.inputToken)?.symbol ?? '?'
  const output = o.outputs[0] ? (tokenByAddress(config, o.outputs[0].token)?.symbol ?? '?') : '?'
  return `pay ${input}, receive ${output}`
}

export function evaluateOrder(td: NormalizedTypedData, ctx: DecisionContext): Decision {
  const order = decode(td)
  if (!order) return reject('malformed_order', 'order fields are not the expected types')
  for (const rule of RULES) {
    const verdict = rule(order, ctx)
    if (verdict) return { ...verdict, summary: summarize(order, verdict.summary) }
  }
  // Every rule passed, so the price is present and the tokens are the pair.
  const pricing = ctx.price ? pricingOf(order, ctx.config, ctx.price.mid) : null
  const label = direction(order, ctx.config)
  return approve('order_compliant', `Permit2 order complies with the Guard Policy (${label})`, {
    ...summarize(order),
    direction: label,
    ...(pricing && ctx.price ? priceFields(pricing, ctx.price) : {}),
  })
}
