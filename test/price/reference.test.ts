import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseLunoTicker } from '../../src/price/luno.js'
import { createPricePoller, staleness } from '../../src/price/reference.js'
import { LIVE_SAMPLE, TICKER_LIMITS } from '../helpers.js'

describe('reference price', () => {
  test('staleness checks our fetch age and the source timestamp separately', () => {
    const limits = { maxAgeSecs: 60, maxSourceAgeSecs: 600 }
    const s = { mid: { num: 1n, den: 1n }, priceTimestampMs: 1_000_000, fetchedAtMs: 1_100_000, pair: 'X', display: '1' }
    assert.equal(staleness(s, 1_160_000, limits), null, 'fetched 60s ago, source 160s old')
    assert.match(staleness(s, 1_160_001, limits) ?? '', /last fetched/)
    assert.match(staleness({ ...s, fetchedAtMs: 1_600_000 }, 1_600_001, limits) ?? '', /source's quote timestamp/)
    assert.match(staleness(null, 0, limits) ?? '', /no reference price/)
    // A snapshot whose source time is far ahead of the guard clock never ages
    // out through the source check, so it is refused outright.
    assert.match(staleness({ ...s, priceTimestampMs: 1_200_001, fetchedAtMs: 1_100_000 }, 1_140_000, limits) ?? '', /in the future/)
    assert.equal(staleness({ ...s, priceTimestampMs: 1_200_000, fetchedAtMs: 1_100_000 }, 1_140_000, limits), null, 'within the skew allowance')
  })

  test('the poller keeps the last good snapshot through failures', async () => {
    let calls = 0
    const events: string[] = []
    const fetcher = async () => {
      calls += 1
      return calls === 1
        ? parseLunoTicker(LIVE_SAMPLE, 'USDCZARU', LIVE_SAMPLE.timestamp + 1, TICKER_LIMITS)
        : { ok: false as const, error: 'down' }
    }
    const poller = createPricePoller(fetcher, 5, (e) => events.push(e))
    await poller.start()
    assert.equal(poller.current()?.display, '16.691700')
    await new Promise((r) => setTimeout(r, 30))
    poller.stop()
    assert.ok(calls >= 2)
    assert.equal(poller.current()?.display, '16.691700', 'last good value survives')
    assert.ok(events.includes('price_error'))
  })
})
