// Structured audit log: one JSON object per line on stdout. Every decision is
// logged with the request id, operation, action, reason and the key order
// fields. Nothing that could be a secret is ever passed in here: no JWTs, no
// key material, no raw request bodies.
//
// Field values often come from the request, so strings are clipped, and the
// fixed fields (ts, level, event, and a decision's action and reason) are
// written last so no other field can overwrite them.

import type { Decision } from './policy/decision.js'
import { clip } from './types.js'

export type AuditFields = Record<string, string | number | boolean | null | undefined>

export type AuditLog = {
  info: (event: string, fields?: AuditFields) => void
  error: (event: string, fields?: AuditFields) => void
  decision: (fields: { requestId: string | null; txId: string | null; operation: string | null; route: string }, decision: Decision) => void
}

const MAX_STRING = 512

const clean = (fields: AuditFields): AuditFields =>
  Object.fromEntries(
    Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === 'string' ? clip(v, MAX_STRING) : v])
  )

export function createAuditLog(write: (line: string) => void, now: () => number = Date.now): AuditLog {
  const emit = (level: 'info' | 'error', event: string, fields: AuditFields = {}) => {
    const head = { ts: new Date(now()).toISOString(), level, event }
    // Spread twice: first for key order, last so nothing overwrites it.
    write(JSON.stringify({ ...head, ...clean(fields), ...head }))
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    error: (event, fields) => emit('error', event, fields),
    decision: (fields, decision) => {
      const fixed = {
        route: fields.route,
        requestId: fields.requestId,
        txId: fields.txId,
        operation: fields.operation,
        action: decision.action,
        reason: decision.reason,
        detail: decision.detail,
      }
      emit('info', 'decision', { ...fixed, ...decision.summary, ...fixed })
    },
  }
}

export const stdoutAuditLog = (): AuditLog => createAuditLog((line) => process.stdout.write(`${line}\n`))
