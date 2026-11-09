import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createLunoFetcher, MAX_TICKER_BYTES, parseLunoTicker } from '../../src/price/luno.js'
import { spreadBps, spreadWithinBps } from '../../src/price/rational.js'
import { LIVE_SAMPLE, TICKER_LIMITS } from '../helpers.js'

describe('Luno ticker', () => {
  test('the live response shape parses to the bid/ask mid', () => {
    const r = parseLunoTicker(LIVE_SAMPLE, 'USDCZARU', 1793281696000, TICKER_LIMITS)
    assert.ok(r.ok)
    assert.equal(r.value.display, '16.691700')
    assert.equal(r.value.priceTimestampMs, 1793281695774)
    assert.equal(r.value.fetchedAtMs, 1793281696000)
    // (16.688 + 16.6954) / 2 = 16.6917
    assert.equal(r.value.mid.num * 10_000n, 166_917n * r.value.mid.den)
  })

  test('wrong pair, inactive market, crossed book or junk is refused', () => {
    const now = LIVE_SAMPLE.timestamp + 1000
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, pair: 'XBTZAR' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, status: 'POSTONLY' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, ask: '16.0' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, bid: '0' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, bid: 16.688 }, 'USDCZARU', now, TICKER_LIMITS).ok, 'numbers are refused: strings only')
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, timestamp: '1793281695774' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker(null, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker('{}', 'USDCZARU', now, TICKER_LIMITS).ok)
  })

  test('an illiquid or broken book with a wide spread is not a reference price', () => {
    const now = LIVE_SAMPLE.timestamp + 1000
    const wide = parseLunoTicker({ ...LIVE_SAMPLE, bid: '1', ask: '100' }, 'USDCZARU', now, TICKER_LIMITS)
    assert.ok(!wide.ok)
    assert.match(wide.error, /spread is \d+ bps/)
    // 16.60 / 16.80 is 119 bps around the mid: out at 100, in at 120.
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, bid: '16.60', ask: '16.80' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(parseLunoTicker({ ...LIVE_SAMPLE, bid: '16.60', ask: '16.80' }, 'USDCZARU', now, { maxSpreadBps: 120 }).ok)
    assert.equal(spreadBps({ num: 1660n, den: 100n }, { num: 1680n, den: 100n }), 119n)
    assert.equal(spreadBps({ num: 1n, den: 1n }, { num: 1n, den: 1n }), 0n)
    // The live sample is a 4 bps book.
    assert.equal(spreadBps({ num: 16688n, den: 1000n }, { num: 166954n, den: 10000n }), 4n)
  })

  test('the spread limit is enforced exactly, not on the truncated bps figure', () => {
    const now = LIVE_SAMPLE.timestamp + 1000
    // bid 1, ask 1.0101: 100.49 bps. Truncation would call it 100 and let it through.
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, bid: '1', ask: '1.0101' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(parseLunoTicker({ ...LIVE_SAMPLE, bid: '1', ask: '1.0101' }, 'USDCZARU', now, { maxSpreadBps: 101 }).ok)
    // bid 199, ask 201: exactly 100 bps around the mid of 200. The edge is inside; one unit past it is not.
    assert.ok(spreadWithinBps({ num: 199n, den: 1n }, { num: 201n, den: 1n }, 100))
    assert.ok(!spreadWithinBps({ num: 199n, den: 1n }, { num: 2010001n, den: 10000n }, 100))
    assert.ok(parseLunoTicker({ ...LIVE_SAMPLE, bid: '199', ask: '201' }, 'USDCZARU', now, TICKER_LIMITS).ok)
    assert.ok(!parseLunoTicker({ ...LIVE_SAMPLE, bid: '199', ask: '201.0001' }, 'USDCZARU', now, TICKER_LIMITS).ok)
  })

  test('a timestamp from the future is refused at parse time', () => {
    const now = LIVE_SAMPLE.timestamp
    assert.ok(parseLunoTicker({ ...LIVE_SAMPLE, timestamp: now + 60_000 }, 'USDCZARU', now, TICKER_LIMITS).ok, 'a minute of clock skew is tolerated')
    const future = parseLunoTicker({ ...LIVE_SAMPLE, timestamp: now + 60_001 }, 'USDCZARU', now, TICKER_LIMITS)
    assert.ok(!future.ok)
    assert.match(future.error, /in the future/)
  })
})

describe('fetcher', () => {
  const OPTS = {
    url: 'https://x',
    pair: 'USDCZARU',
    timeoutMs: 1000,
    maxSpreadBps: 100,
    minPrice: { num: 12n, den: 1n },
    maxPrice: { num: 24n, den: 1n },
  }
  const respond = (body: ConstructorParameters<typeof Response>[0], status = 200) => async () => new Response(body, { status })

  test('a good response becomes a snapshot; errors never throw', async () => {
    const r = await createLunoFetcher(OPTS, respond(JSON.stringify(LIVE_SAMPLE)), () => LIVE_SAMPLE.timestamp + 42)()
    assert.ok(r.ok)
    assert.equal(r.value.fetchedAtMs, LIVE_SAMPLE.timestamp + 42)

    assert.ok(!(await createLunoFetcher(OPTS, respond('{}', 500), () => 0)()).ok)
    const notJson = await createLunoFetcher(OPTS, respond('<html>'), () => 0)()
    assert.ok(!notJson.ok)
    assert.match(notJson.error, /not JSON/)

    const throws = await createLunoFetcher(OPTS, async () => { throw new Error('ECONNREFUSED') }, () => 0)()
    assert.ok(!throws.ok)
    assert.match(throws.error, /ECONNREFUSED/)
  })

  test('a mid outside the configured range is refused', async () => {
    const at = (bid: string, ask: string) =>
      createLunoFetcher(OPTS, respond(JSON.stringify({ ...LIVE_SAMPLE, bid, ask })), () => LIVE_SAMPLE.timestamp)()
    const inverted = await at('0.0599', '0.0600')
    assert.ok(!inverted.ok)
    assert.match(inverted.error, /outside the configured range 12\.000000 to 24\.000000/)
    assert.ok(!(await at('16688', '16695')).ok, 'a thousand times too high')
    assert.ok((await at('12', '12')).ok, 'the bounds are inside')
    assert.ok((await at('24', '24')).ok)
    assert.ok(!(await at('24', '24.0001')).ok)
  })

  test('redirects are refused', async () => {
    let seen: string | undefined
    const r = await createLunoFetcher(OPTS, async (_url, init) => {
      seen = init.redirect
      throw new TypeError('fetch failed: unexpected redirect')
    }, () => 0)()
    assert.equal(seen, 'error')
    assert.ok(!r.ok)
  })

  test('a body over the cap is refused without reading the rest', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x20))
      },
    })
    const r = await createLunoFetcher(OPTS, respond(endless), () => 0)()
    assert.ok(!r.ok)
    assert.match(r.error, new RegExp(`over ${MAX_TICKER_BYTES} bytes`))
    assert.ok(pulled <= MAX_TICKER_BYTES / (16 * 1024) + 2, `stopped after ${pulled} chunks`)
  })

  test('a slow ticker is aborted at the timeout', async () => {
    const slow = createLunoFetcher(
      { ...OPTS, timeoutMs: 20 },
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
      () => 0
    )
    const r = await slow()
    assert.ok(!r.ok)
    assert.match(r.error, /aborted/)
  })
})
