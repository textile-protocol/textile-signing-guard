import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deviationBps, formatRational, impliedPrice, mid, parseDecimal, withinBps } from '../../src/price/rational.js'

describe('rational price math', () => {
  test('decimal parsing is exact', () => {
    assert.deepEqual(parseDecimal('16.6954'), { ok: true, value: { num: 166954n, den: 10000n } })
    assert.deepEqual(parseDecimal('17'), { ok: true, value: { num: 17n, den: 1n } })
    assert.ok(!parseDecimal('1e3').ok)
    assert.ok(!parseDecimal('-1').ok)
    assert.ok(!parseDecimal('.5').ok)
    assert.ok(!parseDecimal('0').ok)
  })

  test('mid and formatting', () => {
    const m = mid({ num: 16688n, den: 1000n }, { num: 166954n, den: 10000n })
    assert.equal(formatRational(m, 4), '16.6917')
    assert.equal(formatRational({ num: 1n, den: 3n }, 6), '0.333333')
  })

  test('implied price handles 18 and 6 decimals in both directions', () => {
    // 1000 USDC (6 dec) buys 16690 ZARU (18 dec): 16.69 ZARU per USDC.
    const buy = impliedPrice(16_690n * 10n ** 18n, 18, 1_000_000_000n, 6)
    assert.ok(buy.ok)
    assert.equal(formatRational(buy.value, 2), '16.69')
    // 1000 ZARU sells for 59.916117 USDC: 1000 / 59.916117 = 16.69000...
    const sell = impliedPrice(1000n * 10n ** 18n, 18, 59_916_117n, 6)
    assert.ok(sell.ok)
    assert.equal(formatRational(sell.value, 4), '16.6900')
    assert.ok(!impliedPrice(0n, 18, 1n, 6).ok)
  })

  test('band check is exact at the boundary', () => {
    const ref = { num: 1669n, den: 100n }
    assert.ok(withinBps({ num: 1669n * 9950n, den: 100n * 10_000n }, ref, 50), '-50 bps inside')
    assert.ok(withinBps({ num: 1669n * 10_050n, den: 100n * 10_000n }, ref, 50), '+50 bps inside')
    assert.ok(!withinBps({ num: 1669n * 9950n - 1n, den: 100n * 10_000n }, ref, 50))
    assert.ok(!withinBps({ num: 1669n * 10_050n + 1n, den: 100n * 10_000n }, ref, 50))
    assert.equal(deviationBps({ num: 1669n * 9950n, den: 100n * 10_000n }, ref), -50n)
    assert.equal(deviationBps({ num: 1669n * 10_100n, den: 100n * 10_000n }, ref), 100n)
  })
})
