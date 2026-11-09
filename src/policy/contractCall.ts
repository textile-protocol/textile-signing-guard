// The single contract call the policy can be configured to allow: an ERC-20
// `approve(Permit2, amount)` on an allowed token, with the amount at or under
// a cap. Off by default. Everything about the call is pinned: the destination
// is a configured token, the calldata is exactly one `approve` call, the
// spender word is Permit2, the amount fits the cap, no native value moves, and
// the Fireblocks asset id names the configured chain.

import type { SignRequest } from '../callback/request.js'
import { type GuardConfig, tokenByAddress } from '../config.js'
import { approve, type Decision, reject } from './decision.js'
import { normalizeAddress, sameAddress } from './typedData.js'

const APPROVE_SELECTOR = '095ea7b3' // approve(address,uint256)

export function evaluateContractCall(req: SignRequest, config: GuardConfig): Decision {
  if (!config.allow.erc20ApprovePermit2 || !config.approve) {
    return reject('operation_not_allowed', 'contract calls are disabled in the policy (allow.erc20_approve_permit2)')
  }
  const summary: Decision['summary'] = { destAddress: req.destAddress, asset: req.asset, amountStr: req.amountStr }

  if (req.asset === null || !config.approve.assetIds.includes(req.asset)) {
    return reject('wrong_asset', `asset ${req.asset} is not one of ${config.approve.assetIds.join(', ')}`, summary)
  }
  // Fireblocks states the native value in amountStr (and amount). Absent is not zero.
  const isZero = (v: string) => /^0(\.0+)?$/.test(v)
  if (req.amountStr === null || !isZero(req.amountStr) || (req.amount !== null && !isZero(req.amount))) {
    const value = req.amountStr ?? req.amount ?? '(not stated)'
    return reject('native_value', `contract call sends native value ${value}; an approve sends none`, summary)
  }
  if (req.destAddress === null) return reject('malformed_call', 'contract call has no destAddress', summary)
  const token = tokenByAddress(config, req.destAddress)
  if (!token) return reject('token_not_allowed', `destination ${req.destAddress} is not an allowed token`, summary)

  const data = req.extraParameters?.['contractCallData']
  if (typeof data !== 'string' || !/^(0x)?[0-9a-fA-F]{136}$/.test(data)) {
    return reject('malformed_call', 'contractCallData is not a 68-byte hex string (selector + two words)', summary)
  }
  const hex = data.replace(/^0x/, '').toLowerCase()
  if (hex.slice(0, 8) !== APPROVE_SELECTOR) {
    return reject('wrong_function', `selector 0x${hex.slice(0, 8)} is not approve(address,uint256)`, summary)
  }
  const spenderWord = hex.slice(8, 72)
  if (!/^0{24}[0-9a-f]{40}$/.test(spenderWord)) return reject('malformed_call', 'spender word has non-zero padding', summary)
  const spender = normalizeAddress(`0x${spenderWord.slice(24)}`)
  if (!spender.ok || !sameAddress(spender.value, config.order.permit2)) {
    return reject('wrong_spender', `approve spender is not Permit2 ${config.order.permit2}`, {
      ...summary,
      spender: spender.ok ? spender.value : null,
    })
  }
  const amount = BigInt(`0x${hex.slice(72, 136)}`)
  const cap = config.approve.maxAmount[token.symbol]
  if (cap === undefined) return reject('token_not_allowed', `no approve cap configured for ${token.symbol}`, summary)
  if (amount > cap) {
    return reject('amount_over_cap', `approve amount ${amount} ${token.symbol} atoms exceeds the cap ${cap}`, {
      ...summary,
      amount: amount.toString(),
    })
  }
  return approve('approve_compliant', `ERC-20 approve(Permit2, ${amount}) on ${token.symbol} is within the cap`, {
    ...summary,
    token: token.symbol,
    spender: spender.value,
    amount: amount.toString(),
  })
}
