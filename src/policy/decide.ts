// The decision function. Pure: (parsed request, config, clock, price) in,
// Decision out. Operation dispatch first, then for a typed message the
// envelope (exactly one EIP712 message), the structural pin, the digest
// cross-check against what the co-signer says it will sign, the policy's
// allow switch for that kind, and finally the kind-specific rules.

import type { SignRequest } from '../callback/request.js'
import type { GuardConfig } from '../config.js'
import { type Hex, isRecord } from '../types.js'
import { evaluateContractCall } from './contractCall.js'
import { type Decision, type DecisionContext, ignore, reject } from './decision.js'
import { evaluateOrder } from './order.js'
import {
  digestOf,
  identifyKind,
  type MessageKind,
  normalizeTypedData,
  type NormalizedTypedData,
  parseTypedData,
} from './typedData.js'
import { evaluateMakerEnroll, evaluateMakerSession, evaluateSignerCheck } from './venue.js'

/** The request must come from the configured vault account, when one is pinned. */
const sourceRule = (req: SignRequest, config: GuardConfig): Decision | null => {
  const expected = config.vault.fireblocksVaultAccountId
  if (expected === null) return null
  const type = req.sourceType ?? ''
  if (type !== 'VAULT' && type !== 'VAULT_ACCOUNT') return reject('wrong_source', `sourceType ${type} is not a vault account`)
  if (req.sourceId !== expected) return reject('wrong_source', `sourceId ${req.sourceId} is not vault account ${expected}`)
  return null
}

type Extracted = { ok: true; content: unknown } | { ok: false; decision: Decision }

/** `extraParameters.rawMessageData.messages`: exactly one EIP712 message. */
const extractTypedContent = (req: SignRequest): Extracted => {
  const refuse = (reason: string, detail: string): Extracted => ({ ok: false, decision: reject(reason, detail) })
  const rmd = req.extraParameters?.['rawMessageData']
  if (!isRecord(rmd)) return refuse('malformed_request', 'extraParameters.rawMessageData is missing')
  const messages = rmd['messages']
  if (!Array.isArray(messages)) return refuse('malformed_request', 'rawMessageData.messages is not an array')
  if (messages.length !== 1) return refuse('message_count', `request carries ${messages.length} messages; exactly one is allowed`)
  const [msg] = messages
  if (!isRecord(msg)) return refuse('malformed_request', 'rawMessageData.messages[0] is not an object')
  if (msg['type'] !== 'EIP712') return refuse('message_type_not_allowed', `message type ${String(msg['type'])} is not EIP712`)
  if (!Object.hasOwn(msg, 'content')) return refuse('malformed_request', 'message has no content')
  return { ok: true, content: msg['content'] }
}

/** Fireblocks' `rawTx[].payload` is bare or 0x-prefixed hex of the hash to sign. */
const signingPayloadRule = (req: SignRequest, digest: Hex, config: GuardConfig): Decision | null => {
  const payloads = req.rawTxPayloads
  if (payloads === null || payloads.length === 0) {
    return config.signingPayload.require
      ? reject('signing_payload_missing', 'request carries no rawTx payload and signing_payload.require is on')
      : null
  }
  const want = digest.slice(2).toLowerCase()
  const bad = payloads.find((p) => p.replace(/^0x/i, '').toLowerCase() !== want)
  return bad === undefined
    ? null
    : reject('signing_payload_mismatch', `rawTx payload ${bad} is not the EIP-712 digest ${digest} of the typed data`)
}

/** Which `allow.*` switch gates each kind, and how the config spells it. */
const ALLOW: Record<MessageKind, { flag: keyof GuardConfig['allow']; key: string; what: string; note?: string }> = {
  permit2_order: { flag: 'permit2Orders', key: 'permit2_orders', what: 'Permit2 orders' },
  maker_session: { flag: 'makerSession', key: 'maker_session', what: 'MakerSession' },
  maker_enroll: { flag: 'makerEnroll', key: 'maker_enroll', what: 'MakerEnroll' },
  signer_check: {
    flag: 'signerCheck',
    key: 'signer_check',
    what: 'SignerCheck',
    note: ' The panel Verify button will fail until it is enabled',
  },
}

const kindAllowedRule = (kind: MessageKind, config: GuardConfig): Decision | null => {
  const gate = ALLOW[kind]
  return config.allow[gate.flag]
    ? null
    : reject('kind_not_allowed', `${gate.what} is disabled in the policy (allow.${gate.key}).${gate.note ?? ''}`)
}

const evaluateKind = (kind: MessageKind, td: NormalizedTypedData, ctx: DecisionContext): Decision => {
  switch (kind) {
    case 'permit2_order':
      return evaluateOrder(td, ctx)
    case 'maker_session':
      return evaluateMakerSession(td, ctx)
    case 'maker_enroll':
      return evaluateMakerEnroll(td, ctx)
    case 'signer_check':
      return evaluateSignerCheck(td)
  }
}

const decideTypedMessage = (req: SignRequest, ctx: DecisionContext): Decision => {
  const extracted = extractTypedContent(req)
  if (!extracted.ok) return extracted.decision

  const raw = parseTypedData(extracted.content)
  if (!raw.ok) return reject('malformed_typed_data', raw.error)
  const kind = identifyKind(raw.value)
  if (kind === null) {
    const detail = `primaryType ${raw.value.primaryType} with these types is not one of the allowed message kinds`
    return reject('message_kind_not_allowed', detail, {
      primaryType: raw.value.primaryType,
      domainName: typeof raw.value.domain['name'] === 'string' ? raw.value.domain['name'] : null,
    })
  }
  const normalized = normalizeTypedData(raw.value)
  if (!normalized.ok) return reject('malformed_typed_data', normalized.error, { kind })
  const digest = digestOf(normalized.value)
  if (!digest.ok) return reject('malformed_typed_data', digest.error, { kind })
  const tagged = { kind, digest: digest.value }

  const verdict =
    signingPayloadRule(req, digest.value, ctx.config) ??
    kindAllowedRule(kind, ctx.config) ??
    evaluateKind(kind, normalized.value, ctx)
  return { ...verdict, summary: { ...tagged, ...verdict.summary } }
}

export function decide(req: SignRequest, ctx: DecisionContext): Decision {
  const source = sourceRule(req, ctx.config)
  if (source) return source
  switch (req.operation) {
    case 'TYPED_MESSAGE':
      return decideTypedMessage(req, ctx)
    case 'CONTRACT_CALL':
      return evaluateContractCall(req, ctx.config)
    default:
      return reject(
        'operation_not_allowed',
        `operation ${req.operation} is not allowed; only TYPED_MESSAGE (and an opt-in Permit2 approve) can be signed`
      )
  }
}

/**
 * Config-change approvals: the bot's API user never asks for these. The
 * signed answer names only the requestId, so a transaction payload sent to
 * this route is always rejected: with IGNORE configured it would otherwise
 * come back as a signed IGNORE for a transaction.
 */
export function decideConfigChange(payload: Record<string, unknown>, config: GuardConfig): Decision {
  if (Object.hasOwn(payload, 'operation')) {
    return reject('config_change_rejected', 'the payload is a transaction, not a configuration change')
  }
  return config.configChangeAction === 'IGNORE'
    ? ignore('config_change_ignored', 'the signing guard does not decide configuration changes')
    : reject('config_change_rejected', 'the signing guard does not approve configuration changes')
}
