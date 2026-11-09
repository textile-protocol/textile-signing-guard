// Send the acceptance cases to a guard and grade the answers.

import type { KeyObject } from 'node:crypto'
import { signRs256, verifyRs256 } from '../callback/jwt.js'
import { errorMessage } from '../types.js'
import type { AcceptanceCase } from './cases.js'

export type CaseResult = {
  id: string
  title: string
  expected: string
  got: string
  pass: boolean
  detail: string
}

export type RunOptions = {
  url: string
  cosignerPrivateKey: KeyObject
  wrongKey: KeyObject
  handlerPublicKey: KeyObject
  fetchImpl?: typeof fetch
  now: () => number
}

const describeExpectation = (c: AcceptanceCase): string =>
  c.expect.kind === 'unauthenticated' ? 'HTTP 401' : `${c.expect.action}${c.expect.reason ? ` (${c.expect.reason})` : ''}`

const bodyFor = (c: AcceptanceCase, opts: RunOptions): string => {
  switch (c.signer) {
    case 'cosigner':
      return signRs256(c.payload, opts.cosignerPrivateKey)
    case 'wrong_key':
      return signRs256(c.payload, opts.wrongKey)
    case 'garbage':
      return 'this is not a jwt'
  }
}

const grade = (c: AcceptanceCase, status: number, body: string, opts: RunOptions): Omit<CaseResult, 'id' | 'title' | 'expected'> => {
  if (c.expect.kind === 'unauthenticated') {
    return status === 401
      ? { got: 'HTTP 401', pass: true, detail: 'refused before any decision' }
      : { got: `HTTP ${status}`, pass: false, detail: body.slice(0, 200) }
  }
  if (status !== 200) return { got: `HTTP ${status}`, pass: false, detail: body.slice(0, 200) }
  const verified = verifyRs256(body, opts.handlerPublicKey, opts.now())
  if (!verified.ok) return { got: 'unverifiable response', pass: false, detail: verified.error }
  const claims = verified.value.payload
  const action = typeof claims['action'] === 'string' ? claims['action'] : '?'
  const requestId = claims['requestId']
  const reason = typeof claims['rejectionReason'] === 'string' ? claims['rejectionReason'] : ''
  const reasonCode = reason.split(':')[0] ?? ''
  const got = reason ? `${action} (${reasonCode})` : action
  if (requestId !== c.payload['requestId']) return { got, pass: false, detail: `response requestId ${String(requestId)} does not match` }
  if (action !== c.expect.action) return { got, pass: false, detail: reason || 'unexpected action' }
  if (c.expect.reason && action === 'REJECT' && reasonCode !== c.expect.reason) {
    return { got, pass: false, detail: `rejected for ${reasonCode}, expected ${c.expect.reason}: ${reason}` }
  }
  return { got, pass: true, detail: reason || 'approved' }
}

export async function runCases(cases: AcceptanceCase[], opts: RunOptions): Promise<CaseResult[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const results: CaseResult[] = []
  for (const c of cases) {
    const expected = describeExpectation(c)
    try {
      const res = await fetchImpl(`${opts.url.replace(/\/$/, '')}${c.route}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: bodyFor(c, opts),
      })
      const text = await res.text()
      results.push({ id: c.id, title: c.title, expected, ...grade(c, res.status, text, opts) })
    } catch (e) {
      results.push({ id: c.id, title: c.title, expected, got: 'no response', pass: false, detail: errorMessage(e) })
    }
  }
  return results
}

export type ReportMeta = Record<string, string | number | boolean | null>

export function renderReport(meta: ReportMeta, results: CaseResult[]): string {
  const passed = results.filter((r) => r.pass).length
  const lines: string[] = ['Signing Guard acceptance test', '']
  for (const [k, v] of Object.entries(meta)) lines.push(`${k.padEnd(22)} ${String(v)}`)
  lines.push('')
  const idWidth = Math.max(...results.map((r) => r.id.length), 4)
  const expWidth = Math.max(...results.map((r) => r.expected.length), 8)
  lines.push(`${'RESULT'.padEnd(6)} ${'CASE'.padEnd(idWidth)} ${'EXPECTED'.padEnd(expWidth)} GOT`)
  for (const r of results) {
    lines.push(`${(r.pass ? 'PASS' : 'FAIL').padEnd(6)} ${r.id.padEnd(idWidth)} ${r.expected.padEnd(expWidth)} ${r.got}`)
    lines.push(`       ${r.title}`)
    if (!r.pass) lines.push(`       -> ${r.detail}`)
  }
  lines.push('')
  lines.push(`${passed}/${results.length} cases passed. ${passed === results.length ? 'RESULT: PASS' : 'RESULT: FAIL'}`)
  return lines.join('\n')
}
