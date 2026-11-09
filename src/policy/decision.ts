// What a policy rule returns, and everything a rule may read. The policy is a
// pure function of (request, config, clock, price snapshot).

import type { GuardConfig } from '../config.js'
import type { PriceSnapshot } from '../price/reference.js'

/**
 * What the guard tells the co-signer. `reason` is a short machine-readable
 * code; `detail` is the human sentence that goes into the response's
 * `rejectionReason` and the audit log. `summary` holds the order fields worth
 * auditing (no secrets ever go in here).
 */
export type Decision = {
  action: 'APPROVE' | 'REJECT' | 'IGNORE'
  reason: string
  detail: string
  summary: Record<string, string | number | boolean | null>
}

const decision =
  (action: Decision['action']) =>
  (reason: string, detail: string, summary: Decision['summary'] = {}): Decision => ({ action, reason, detail, summary })

export const reject = decision('REJECT')
export const approve = decision('APPROVE')
export const ignore = decision('IGNORE')

/** Everything a decision may read: the policy, the clock, the latest price. */
export type DecisionContext = {
  config: GuardConfig
  nowMs: number
  price: PriceSnapshot | null
}
