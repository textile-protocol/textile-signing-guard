// Messages that authenticate the bot to the Textile venue, plus the panel's
// connectivity check. None of them moves funds, which is why the checks are
// about identity: the right domain name, the vault as the signing address,
// the policy's chain, and a timestamp that is roughly now.

import { approve, type Decision, type DecisionContext, reject } from './decision.js'
import { asBigint, asString, type NormalizedTypedData, sameAddress } from './typedData.js'

type Summary = Decision['summary']

const domainRule = (what: string, name: string, version: string, expected: string, summary: Summary): Decision | null => {
  if (name !== expected) {
    return reject('wrong_domain', `${what} domain is ${JSON.stringify(name)}, policy allows ${JSON.stringify(expected)}`, summary)
  }
  if (version !== '1') return reject('wrong_domain', `${what} domain version is ${version}, expected 1`, summary)
  return null
}

const signingAddressRule = (signingAddress: string, ctx: DecisionContext, summary: Summary): Decision | null =>
  sameAddress(signingAddress, ctx.config.vault.address)
    ? null
    : reject('wrong_signing_address', `signingAddress ${signingAddress} is not the vault ${ctx.config.vault.address}`, summary)

const issuedAtRule = (issuedAt: bigint, ctx: DecisionContext, summary: Summary): Decision | null => {
  const nowMs = BigInt(ctx.nowMs)
  const skew = BigInt(ctx.config.venue.maxIssuedAtSkewSecs) * 1000n
  const diff = issuedAt > nowMs ? issuedAt - nowMs : nowMs - issuedAt
  return diff <= skew
    ? null
    : reject('issued_at_skew', `issuedAt ${issuedAt} is more than ${ctx.config.venue.maxIssuedAtSkewSecs}s from now ${nowMs} (unix ms)`, summary)
}

export function evaluateMakerSession(td: NormalizedTypedData, ctx: DecisionContext): Decision {
  const name = asString(td.domain['name'])
  const version = asString(td.domain['version'])
  const makerId = asString(td.message['makerId'])
  const signingAddress = asString(td.message['signingAddress'])
  const issuedAt = asBigint(td.message['issuedAt'])
  if (name === null || version === null || makerId === null || signingAddress === null || issuedAt === null) {
    return reject('malformed_message', 'MakerSession fields are not the expected types')
  }
  const summary = { domain: name, makerId, signingAddress, issuedAt: issuedAt.toString() }
  return (
    domainRule('session', name, version, ctx.config.venue.sessionDomainName, summary) ??
    signingAddressRule(signingAddress, ctx, summary) ??
    issuedAtRule(issuedAt, ctx, summary) ??
    approve('session_compliant', 'MakerSession authenticates the vault to the venue', summary)
  )
}

export function evaluateMakerEnroll(td: NormalizedTypedData, ctx: DecisionContext): Decision {
  const { config } = ctx
  const name = asString(td.domain['name'])
  const version = asString(td.domain['version'])
  const domainChainId = asBigint(td.domain['chainId'])
  const signingAddress = asString(td.message['signingAddress'])
  const fundingWallet = asString(td.message['fundingWallet'])
  const chainId = asBigint(td.message['chainId'])
  const issuedAt = asBigint(td.message['issuedAt'])
  if (
    name === null ||
    version === null ||
    domainChainId === null ||
    signingAddress === null ||
    fundingWallet === null ||
    chainId === null ||
    issuedAt === null
  ) {
    return reject('malformed_message', 'MakerEnroll fields are not the expected types')
  }
  const summary = { domain: name, signingAddress, fundingWallet, chainId: chainId.toString(), issuedAt: issuedAt.toString() }
  const chainRule = (): Decision | null =>
    domainChainId === BigInt(config.chainId) && chainId === BigInt(config.chainId)
      ? null
      : reject('wrong_chain', `enroll chainId ${domainChainId}/${chainId} is not the policy chain ${config.chainId}`, summary)
  const fundingRule = (): Decision | null =>
    sameAddress(fundingWallet, config.venue.fundingWallet)
      ? null
      : reject('wrong_funding_wallet', `fundingWallet ${fundingWallet} is not ${config.venue.fundingWallet}`, summary)
  return (
    domainRule('enroll', name, version, config.venue.enrollDomainName, summary) ??
    chainRule() ??
    signingAddressRule(signingAddress, ctx, summary) ??
    fundingRule() ??
    issuedAtRule(issuedAt, ctx, summary) ??
    approve('enroll_compliant', 'MakerEnroll registers the vault with the venue', summary)
  )
}

export function evaluateSignerCheck(td: NormalizedTypedData): Decision {
  const name = asString(td.domain['name'])
  const version = asString(td.domain['version'])
  const nonce = asString(td.message['nonce'])
  if (name === null || version === null || nonce === null) {
    return reject('malformed_message', 'SignerCheck fields are not the expected types')
  }
  const summary = { domain: name, nonce }
  return (
    domainRule('signer check', name, version, 'Stitch Signer Check', summary) ??
    approve('signer_check', 'SignerCheck authorises nothing; allowed by allow.signer_check', summary)
  )
}
