import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAuditLog } from '../src/audit.js'
import { reject } from '../src/policy/decision.js'

const capture = () => {
  const lines: Record<string, unknown>[] = []
  const log = createAuditLog((l) => lines.push(JSON.parse(l) as Record<string, unknown>), () => 0)
  return { log, lines }
}

describe('audit log', () => {
  test('a decision summary cannot overwrite the action, reason or request id', () => {
    const { log, lines } = capture()
    const decision = reject('wrong_recipient', 'pays someone else', { action: 'APPROVE', reason: 'order_compliant', requestId: 'other' })
    log.decision({ requestId: 'r1', txId: 't1', operation: 'TYPED_MESSAGE', route: '/v2/tx_sign_request' }, decision)
    assert.equal(lines[0]?.['action'], 'REJECT')
    assert.equal(lines[0]?.['reason'], 'wrong_recipient')
    assert.equal(lines[0]?.['requestId'], 'r1')
    assert.equal(lines[0]?.['event'], 'decision')
  })

  test('fields cannot overwrite ts, level or event', () => {
    const { log, lines } = capture()
    log.error('price_error', { event: 'decision', level: 'info', ts: 'then' })
    assert.deepEqual([lines[0]?.['event'], lines[0]?.['level'], lines[0]?.['ts']], ['price_error', 'error', new Date(0).toISOString()])
  })

  test('long strings are clipped and undefined fields dropped', () => {
    const { log, lines } = capture()
    log.info('x', { long: 'a'.repeat(10_000), gone: undefined })
    const long = String(lines[0]?.['long'])
    assert.ok(long.length < 600)
    assert.match(long, /\(10000 chars\)$/)
    assert.ok(!('gone' in (lines[0] ?? {})))
  })
})
