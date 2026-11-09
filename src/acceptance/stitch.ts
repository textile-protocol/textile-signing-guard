// Builders that produce the exact typed-data documents Stitch sends to
// Fireblocks, mirrored from Stitch's `src/protocol/typed_data.rs` and
// `src/rfq/order.rs` (github.com/textile-protocol/textile-stitch). Used by
// the acceptance CLI (to send realistic requests) and by tests, which check
// them byte-for-byte against fixtures dumped from the Rust code.
//
// Conventions copied from the Rust: addresses lower-case `0x` hex, `uint256`
// message values as decimal strings, domain `chainId` as a JSON number.

import { encodeAbiParameters, encodeFunctionData, erc20Abi } from 'viem'
import { MAKER_ENROLL_TYPES, MAKER_SESSION_TYPES, PERMIT2_ORDER_TYPES, SIGNER_CHECK_TYPES } from '../policy/typedData.js'
import type { Hex } from '../types.js'

const lower = (a: string): string => a.toLowerCase()

export type OrderInput = {
  chainId: number
  permit2: string
  reactor: string
  swapper: string
  recipient: string
  nonce: bigint
  deadline: bigint
  inputToken: string
  inputAmount: bigint
  outputToken: string
  outputAmount: bigint
  validationContract: string
  validationData: Hex
}

/** `abi.encode(address[] preferredFillers, uint256 exclusiveUntil)`. */
export const encodePreferredFillerValidation = (fillers: string[], exclusiveUntil: bigint): Hex =>
  encodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint256' }],
    [fillers.map((f) => f as Hex), exclusiveUntil]
  )

/** `permit2_typed_data` in typed_data.rs. One output, same as every v1 order. */
export function buildOrderTypedData(o: OrderInput): Record<string, unknown> {
  return {
    types: PERMIT2_ORDER_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    domain: { name: 'Permit2', chainId: o.chainId, verifyingContract: lower(o.permit2) },
    message: {
      permitted: { token: lower(o.inputToken), amount: o.inputAmount.toString() },
      spender: lower(o.reactor),
      nonce: o.nonce.toString(),
      deadline: o.deadline.toString(),
      witness: {
        info: {
          reactor: lower(o.reactor),
          swapper: lower(o.swapper),
          nonce: o.nonce.toString(),
          deadline: o.deadline.toString(),
          additionalValidationContract: lower(o.validationContract),
          additionalValidationData: o.validationData,
        },
        inputToken: lower(o.inputToken),
        inputAmount: o.inputAmount.toString(),
        outputs: [{ token: lower(o.outputToken), amount: o.outputAmount.toString(), recipient: lower(o.recipient) }],
      },
    },
  }
}

export function buildMakerSessionTypedData(p: {
  domainName: string
  makerId: string
  signingAddress: string
  challenge: Hex
  issuedAtMs: bigint
}): Record<string, unknown> {
  return {
    types: MAKER_SESSION_TYPES,
    primaryType: 'MakerSession',
    domain: { name: p.domainName, version: '1' },
    message: {
      makerId: p.makerId,
      signingAddress: lower(p.signingAddress),
      challenge: p.challenge,
      issuedAt: p.issuedAtMs.toString(),
    },
  }
}

export function buildMakerEnrollTypedData(p: {
  domainName: string
  signingAddress: string
  fundingWallet: string
  chainId: number
  issuedAtMs: bigint
}): Record<string, unknown> {
  return {
    types: MAKER_ENROLL_TYPES,
    primaryType: 'MakerEnroll',
    domain: { name: p.domainName, version: '1', chainId: p.chainId },
    message: {
      signingAddress: lower(p.signingAddress),
      fundingWallet: lower(p.fundingWallet),
      chainId: String(p.chainId),
      issuedAt: p.issuedAtMs.toString(),
    },
  }
}

export function buildSignerCheckTypedData(nonce: Hex): Record<string, unknown> {
  return {
    types: SIGNER_CHECK_TYPES,
    primaryType: 'SignerCheck',
    domain: { name: 'Stitch Signer Check', version: '1' },
    message: { nonce },
  }
}

/** An EIP-2612 `permit` under a token's own domain: what the guard must refuse. */
export function buildErc2612PermitTypedData(p: {
  chainId: number
  token: string
  tokenName: string
  owner: string
  spender: string
  value: bigint
  nonce: bigint
  deadline: bigint
}): Record<string, unknown> {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    domain: { name: p.tokenName, version: '2', chainId: p.chainId, verifyingContract: lower(p.token) },
    message: {
      owner: lower(p.owner),
      spender: lower(p.spender),
      value: p.value.toString(),
      nonce: p.nonce.toString(),
      deadline: p.deadline.toString(),
    },
  }
}

/** The `tx_sign_request` envelope Fireblocks wraps a typed message in. */
export function typedMessageRequest(
  content: unknown,
  ids: { requestId: string; vaultAccountId: string },
  messageType = 'EIP712'
): Record<string, unknown> {
  return {
    txId: ids.requestId,
    requestId: ids.requestId,
    operation: 'TYPED_MESSAGE',
    sourceType: 'VAULT',
    sourceId: ids.vaultAccountId,
    destType: 'ONE_TIME',
    asset: 'ETH',
    amount: 0,
    amountStr: '0',
    note: 'signing guard acceptance test',
    extraParameters: { rawMessageData: { messages: [{ content, type: messageType, index: 0 }] } },
  }
}

/** A `CONTRACT_CALL` envelope for an ERC-20 `approve(spender, amount)`. */
export function approveContractCallRequest(p: {
  requestId: string
  vaultAccountId: string
  asset: string
  token: string
  spender: string
  amount: bigint
}): Record<string, unknown> {
  const calldata = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [p.spender as Hex, p.amount] })
  return {
    txId: p.requestId,
    requestId: p.requestId,
    operation: 'CONTRACT_CALL',
    sourceType: 'VAULT',
    sourceId: p.vaultAccountId,
    destType: 'ONE_TIME',
    destAddressType: 'ONE_TIME',
    destAddress: p.token,
    asset: p.asset,
    amount: 0,
    amountStr: '0',
    extraParameters: { contractCallData: calldata },
  }
}
