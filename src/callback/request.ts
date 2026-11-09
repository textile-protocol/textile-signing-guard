// The co-signer's `tx_sign_request` payload, reduced to the fields the policy
// reads. Fireblocks documents many more (destinations, players, fee, ...);
// those pass through untouched and unlogged. The ones we read must have the
// documented JSON type or the request is refused.
//
// Reference: https://developers.fireblocks.com/reference/approve-transactions

import { err, isRecord, ok, type Result } from '../types.js'

export type SignRequest = {
  requestId: string
  txId: string | null
  operation: string
  sourceType: string | null
  sourceId: string | null
  destAddress: string | null
  asset: string | null
  /** The native value, as Fireblocks states it in `amountStr` and `amount`. */
  amountStr: string | null
  amount: string | null
  extraParameters: Record<string, unknown> | null
  /** `rawTx[i].payload`: the hash the co-signer will sign, when Fireblocks sends it. */
  rawTxPayloads: string[] | null
}

const optString = (v: unknown, name: string): Result<string | null> => {
  if (v === undefined || v === null) return ok(null)
  if (typeof v === 'string') return ok(v)
  // Vault account ids show up as numbers in some Fireblocks responses.
  if (typeof v === 'number' && Number.isSafeInteger(v)) return ok(String(v))
  return err(`${name} is not a string`)
}

/** `amount` is a JSON number in Fireblocks payloads; kept as its decimal text. */
const optAmount = (v: unknown): Result<string | null> => {
  if (v === undefined || v === null) return ok(null)
  if (typeof v === 'string') return ok(v)
  if (typeof v === 'number' && Number.isFinite(v)) return ok(String(v))
  return err('amount is not a number')
}

const parseRawTx = (v: unknown): Result<string[] | null> => {
  if (v === undefined || v === null) return ok(null)
  if (!Array.isArray(v)) return err('rawTx is not an array')
  const out: string[] = []
  for (const [i, entry] of v.entries()) {
    if (!isRecord(entry)) return err(`rawTx[${i}] is not an object`)
    const payload = entry['payload']
    if (typeof payload !== 'string' || payload.length === 0) return err(`rawTx[${i}].payload is not a string`)
    out.push(payload)
  }
  return ok(out)
}

/** `requestId` and `operation` are required; everything else is optional but typed. */
export function parseSignRequest(payload: unknown): Result<SignRequest> {
  if (!isRecord(payload)) return err('request payload is not an object')
  const requestId = payload['requestId']
  if (typeof requestId !== 'string' || requestId.length === 0) return err('requestId is missing')
  const operation = payload['operation']
  if (typeof operation !== 'string' || operation.length === 0) return err('operation is missing')

  const txId = optString(payload['txId'], 'txId')
  if (!txId.ok) return txId
  const sourceType = optString(payload['sourceType'], 'sourceType')
  if (!sourceType.ok) return sourceType
  const sourceId = optString(payload['sourceId'], 'sourceId')
  if (!sourceId.ok) return sourceId
  const destAddress = optString(payload['destAddress'], 'destAddress')
  if (!destAddress.ok) return destAddress
  const asset = optString(payload['asset'], 'asset')
  if (!asset.ok) return asset
  const amountStr = optString(payload['amountStr'], 'amountStr')
  if (!amountStr.ok) return amountStr
  const amount = optAmount(payload['amount'])
  if (!amount.ok) return amount
  const extra = payload['extraParameters']
  if (extra !== undefined && extra !== null && !isRecord(extra)) return err('extraParameters is not an object')
  const rawTxPayloads = parseRawTx(payload['rawTx'])
  if (!rawTxPayloads.ok) return rawTxPayloads

  return ok({
    requestId,
    txId: txId.value,
    operation,
    sourceType: sourceType.value,
    sourceId: sourceId.value,
    destAddress: destAddress.value,
    asset: asset.value,
    amountStr: amountStr.value,
    amount: amount.value,
    extraParameters: isRecord(extra) ? extra : null,
    rawTxPayloads: rawTxPayloads.value,
  })
}

/** Best-effort id for a request that failed to parse, so the reject names it. */
export function requestIdOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const id = payload['requestId'] ?? payload['txId']
  return typeof id === 'string' && id.length > 0 ? id : null
}
