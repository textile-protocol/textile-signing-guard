import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decide } from '../../src/policy/decide.js'
import { ATTACKER, fixture, NOW_MS, PRICE, requestFor, setPath, testConfig, VAULT } from '../helpers.js'

const config = testConfig()
const ctx = { config, nowMs: NOW_MS, price: PRICE }
const run = (doc: Record<string, unknown>, c = ctx) => decide(requestFor(doc), c)

describe('MakerSession', () => {
  test('the LIVE session for the vault is approved', () => {
    const d = run(fixture('maker_session_live').typedData)
    assert.equal(d.action, 'APPROVE', d.detail)
    assert.equal(d.reason, 'session_compliant')
    assert.equal(d.summary['kind'], 'maker_session')
    assert.equal(d.summary['signingAddress'], VAULT)
  })

  test('the TEST domain is rejected', () => {
    assert.equal(run(fixture('maker_session_test').typedData).reason, 'wrong_domain')
  })

  test('a signing address that is not the vault is rejected', () => {
    assert.equal(run(setPath(fixture('maker_session_live').typedData, 'message.signingAddress', ATTACKER)).reason, 'wrong_signing_address')
  })

  test('an issuedAt far from now is rejected', () => {
    const doc = setPath(fixture('maker_session_live').typedData, 'message.issuedAt', String(NOW_MS - 301_000))
    assert.equal(run(doc).reason, 'issued_at_skew')
    const future = setPath(fixture('maker_session_live').typedData, 'message.issuedAt', String(NOW_MS + 301_000))
    assert.equal(run(future).reason, 'issued_at_skew')
    const edge = setPath(fixture('maker_session_live').typedData, 'message.issuedAt', String(NOW_MS - 300_000))
    assert.equal(run(edge).action, 'APPROVE')
  })

  test('a domain version other than 1 is rejected', () => {
    assert.equal(run(setPath(fixture('maker_session_live').typedData, 'domain.version', '2')).reason, 'wrong_domain')
  })

  test('sessions can be disabled', () => {
    const off = testConfig((d) => {
      ;(d['allow'] as Record<string, unknown>)['maker_session'] = false
    })
    assert.equal(run(fixture('maker_session_live').typedData, { ...ctx, config: off }).reason, 'kind_not_allowed')
  })
})

describe('MakerEnroll', () => {
  test('LIVE enroll on the policy chain for the vault is approved', () => {
    const d = run(fixture('maker_enroll_live_base').typedData)
    assert.equal(d.action, 'APPROVE', d.detail)
    assert.equal(d.reason, 'enroll_compliant')
  })

  test('enroll on another chain is rejected', () => {
    assert.equal(run(fixture('maker_enroll_live_bsc').typedData).reason, 'wrong_chain')
    // Domain says 8453 but the message says 56: still wrong.
    assert.equal(run(setPath(fixture('maker_enroll_live_base').typedData, 'message.chainId', '56')).reason, 'wrong_chain')
  })

  test('the TEST domain, another signer or another funding wallet is rejected', () => {
    assert.equal(run(setPath(fixture('maker_enroll_live_base').typedData, 'domain.name', 'Textile Maker Enroll (TEST)')).reason, 'wrong_domain')
    assert.equal(run(setPath(fixture('maker_enroll_live_base').typedData, 'message.signingAddress', ATTACKER)).reason, 'wrong_signing_address')
    assert.equal(run(setPath(fixture('maker_enroll_live_base').typedData, 'message.fundingWallet', ATTACKER)).reason, 'wrong_funding_wallet')
  })

})

describe('SignerCheck', () => {
  test('is rejected by default and approved when allowed', () => {
    const d = run(fixture('signer_check').typedData)
    assert.equal(d.action, 'REJECT')
    assert.equal(d.reason, 'kind_not_allowed')
    const on = testConfig((doc) => {
      ;(doc['allow'] as Record<string, unknown>)['signer_check'] = true
    })
    const ok = run(fixture('signer_check').typedData, { ...ctx, config: on })
    assert.equal(ok.action, 'APPROVE')
    assert.equal(ok.reason, 'signer_check')
  })

  test('another domain with the SignerCheck struct is rejected even when allowed', () => {
    const on = testConfig((doc) => {
      ;(doc['allow'] as Record<string, unknown>)['signer_check'] = true
    })
    assert.equal(run(setPath(fixture('signer_check').typedData, 'domain.name', 'Other'), { ...ctx, config: on }).reason, 'wrong_domain')
  })
})

describe('messages Stitch signs that the policy does not list', () => {
  test('NAV attestation and GMX recall quotes are rejected as unknown kinds', () => {
    for (const name of ['nav_attestation_v2', 'recall_quote']) {
      const d = run(fixture(name).typedData)
      assert.equal(d.action, 'REJECT', name)
      assert.equal(d.reason, 'message_kind_not_allowed', name)
    }
  })
})
