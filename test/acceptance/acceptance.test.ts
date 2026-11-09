import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildCases, orderAmounts } from '../../src/acceptance/cases.js'
import { type LoopbackGuard, startLoopbackGuard } from '../../src/acceptance/loopback.js'
import { type CaseResult, renderReport, runCases } from '../../src/acceptance/run.js'
import type { GuardConfig } from '../../src/config.js'
import { PRICE, rsaPair, section, testConfig } from '../helpers.js'

const livePrice = () => ({ ...PRICE, priceTimestampMs: Date.now() - 500, fetchedAtMs: Date.now() })

/** Run the suite built for `casesConfig` against a guard running `guardConfig`. */
const runSuite = async (guardConfig: GuardConfig, casesConfig = guardConfig): Promise<CaseResult[]> => {
  const guard: LoopbackGuard = await startLoopbackGuard({ config: guardConfig, price: livePrice })
  try {
    return await runCases(buildCases(casesConfig, PRICE.mid, Date.now()), {
      url: guard.url,
      cosignerPrivateKey: guard.cosigner.privateKey,
      wrongKey: rsaPair().privateKey,
      handlerPublicKey: guard.handler.publicKey,
      now: Date.now,
    })
  } finally {
    await guard.close()
  }
}

describe('acceptance suite', () => {
  test('every case passes against a guard running the test policy', async () => {
    const cases = buildCases(testConfig(), PRICE.mid, Date.now())
    assert.ok(cases.length >= 30)
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'case ids are unique')
    const results = await runSuite(testConfig())
    assert.deepEqual(results.filter((r) => !r.pass), [], renderReport({}, results))
  })

  test('expectations follow the policy: signer check and approve flip with their flags', async () => {
    const permissive = testConfig((d) => {
      section(d, 'allow')['signer_check'] = true
      section(d, 'allow')['erc20_approve_permit2'] = true
      d['config_change_action'] = 'IGNORE'
    })
    const byId = Object.fromEntries(buildCases(permissive, PRICE.mid, Date.now()).map((c) => [c.id, c]))
    assert.deepEqual(byId['signer-check']?.expect, { kind: 'decision', action: 'APPROVE', reason: 'signer_check' })
    assert.deepEqual(byId['approve-permit2']?.expect, { kind: 'decision', action: 'APPROVE', reason: 'approve_compliant' })
    assert.deepEqual(byId['approve-over-cap']?.expect, { kind: 'decision', action: 'REJECT', reason: 'amount_over_cap' })
    assert.deepEqual(byId['config-change']?.expect, { kind: 'decision', action: 'IGNORE', reason: 'config_change_ignored' })
    const results = await runSuite(permissive)
    assert.deepEqual(results.filter((r) => !r.pass), [], renderReport({}, results))
  })

  test('the suite fails loudly when the guard is wrong', async () => {
    // A guard whose policy allows a different vault: the compliant cases
    // (built for the test vault) must now come back REJECT and be reported.
    const otherVault = testConfig((d) => {
      section(d, 'vault')['address'] = '0x1111111111111111111111111111111111111111'
    })
    const results = await runSuite(otherVault, testConfig())
    const failed = results.filter((r) => !r.pass).map((r) => r.id)
    assert.ok(failed.includes('order-pay-base'))
    assert.ok(failed.includes('maker-session'))
    assert.match(renderReport({}, results), /RESULT: FAIL/)
  })

  test('order amounts sit on the reference price in both directions', () => {
    const cfg = testConfig()
    const payUsdc = orderAmounts(cfg, PRICE.mid, true)
    assert.equal(payUsdc.inputToken.symbol, 'USDC')
    assert.equal(payUsdc.inputAmount, 100n * 10n ** 6n)
    assert.equal(payUsdc.outputAmount, 1669n * 10n ** 18n)
    const payZaru = orderAmounts(cfg, PRICE.mid, false)
    assert.equal(payZaru.inputToken.symbol, 'ZARU')
    assert.equal(payZaru.outputAmount, 5_991_611n, '100 ZARU / 16.69 = 5.991611 USDC')
    const capped = orderAmounts(cfg, PRICE.mid, true, 0n, 7n * 10n ** 6n)
    assert.equal(capped.inputAmount, 7n * 10n ** 6n)
  })
})
