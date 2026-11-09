import assert from 'node:assert/strict'
import net from 'node:net'
import { after, before, describe, test } from 'node:test'
import { type LoopbackGuard, startLoopbackGuard } from '../../src/acceptance/loopback.js'
import { typedMessageRequest } from '../../src/acceptance/stitch.js'
import { createAuditLog } from '../../src/audit.js'
import { signRs256, verifyRs256 } from '../../src/callback/jwt.js'
import { CONFIG_CHANGE_ROUTE, MAX_BODY_BYTES, TX_SIGN_ROUTE } from '../../src/callback/server.js'
import type { PriceSnapshot } from '../../src/price/reference.js'
import { fixture, NOW_MS, PRICE, rsaPair, testConfig } from '../helpers.js'

const stranger = rsaPair()
const lines: string[] = []
let price: PriceSnapshot | null = PRICE
let guard: LoopbackGuard

const post = (route: string, body: string | Buffer) =>
  fetch(`${guard.url}${route}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })

const claimsOf = async (res: Response) => {
  assert.equal(res.status, 200)
  const v = verifyRs256(await res.text(), guard.handler.publicKey, NOW_MS)
  assert.ok(v.ok, v.ok ? '' : v.error)
  return v.value.payload
}

before(async () => {
  guard = await startLoopbackGuard({
    config: testConfig(),
    configSha256: 'cafe',
    price: () => price,
    now: () => NOW_MS,
    log: createAuditLog((l) => lines.push(l), () => NOW_MS),
    version: 'test',
  })
})

after(() => guard.close())

describe('callback routes', () => {
  test('a compliant order signed by the co-signer gets a signed APPROVE naming the request', async () => {
    const req = typedMessageRequest(fixture('permit2_sell_zaru_rfq').typedData, { requestId: 'tx-approve', vaultAccountId: '0' })
    const claims = await claimsOf(await post(TX_SIGN_ROUTE, signRs256(req, guard.cosigner.privateKey)))
    assert.equal(claims['action'], 'APPROVE')
    assert.equal(claims['requestId'], 'tx-approve')
    assert.equal(claims['rejectionReason'], undefined)
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['requestId'] === 'tx-approve')
    assert.ok(logged)
    assert.equal(logged['event'], 'decision')
    assert.equal(logged['action'], 'APPROVE')
    assert.equal(logged['operation'], 'TYPED_MESSAGE')
    assert.equal(logged['kind'], 'permit2_order')
  })

  test('a non-compliant order gets a signed REJECT with the reason', async () => {
    const doc = fixture('maker_session_test').typedData
    const req = typedMessageRequest(doc, { requestId: 'tx-reject', vaultAccountId: '0' })
    const claims = await claimsOf(await post(TX_SIGN_ROUTE, signRs256(req, guard.cosigner.privateKey)))
    assert.equal(claims['action'], 'REJECT')
    assert.equal(claims['requestId'], 'tx-reject')
    assert.match(String(claims['rejectionReason']), /^wrong_domain: /)
  })

  test('a JWT from a key that is not the co-signer is refused with 401 and no decision', async () => {
    const req = typedMessageRequest(fixture('permit2_sell_zaru_rfq').typedData, { requestId: 'tx-stranger', vaultAccountId: '0' })
    const res = await post(TX_SIGN_ROUTE, signRs256(req, stranger.privateKey))
    assert.equal(res.status, 401)
    assert.ok(!lines.some((l) => l.includes('tx-stranger')), 'nothing about the request is logged as a decision')
  })

  test('a malformed JWT, a bare JSON body and an unsigned token are refused with 401', async () => {
    for (const body of ['garbage', JSON.stringify({ requestId: 'x', operation: 'TYPED_MESSAGE' }), 'eyJhbGciOiJub25lIn0.e30.', '']) {
      assert.equal((await post(TX_SIGN_ROUTE, body)).status, 401, JSON.stringify(body))
    }
  })

  test('a verified request without a usable requestId is a 400; with one but malformed, a signed REJECT', async () => {
    assert.equal((await post(TX_SIGN_ROUTE, signRs256({ foo: 1 }, guard.cosigner.privateKey))).status, 400)
    const claims = await claimsOf(await post(TX_SIGN_ROUTE, signRs256({ requestId: 'tx-noop' }, guard.cosigner.privateKey)))
    assert.equal(claims['action'], 'REJECT')
    assert.match(String(claims['rejectionReason']), /^malformed_request: /)
  })

  test('a rejection reason that echoes a huge field is clipped', async () => {
    const req = { requestId: 'tx-long', operation: 'X'.repeat(100_000), sourceType: 'VAULT', sourceId: '0' }
    const claims = await claimsOf(await post(TX_SIGN_ROUTE, signRs256(req, guard.cosigner.privateKey)))
    assert.equal(claims['action'], 'REJECT')
    assert.ok(String(claims['rejectionReason']).length < 600)
    assert.match(String(claims['rejectionReason']), /^operation_not_allowed: /)
  })

  test('configuration changes are rejected', async () => {
    const claims = await claimsOf(await post(CONFIG_CHANGE_ROUTE, signRs256({ requestId: 'cfg-1', type: 'ADD_USER' }, guard.cosigner.privateKey)))
    assert.equal(claims['action'], 'REJECT')
    assert.equal(claims['requestId'], 'cfg-1')
  })

  test('wrong methods and unknown paths', async () => {
    assert.equal((await fetch(`${guard.url}${TX_SIGN_ROUTE}`)).status, 405)
    assert.equal((await fetch(`${guard.url}/healthz`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${guard.url}/v1/tx_sign_request`, { method: 'POST', body: 'x' })).status, 404)
    assert.equal((await fetch(`${guard.url}/`)).status, 404)
  })

  test('an oversized body is refused', async () => {
    const res = await post(TX_SIGN_ROUTE, Buffer.alloc(MAX_BODY_BYTES + 1, 0x61))
    assert.equal(res.status, 413)
  })

  test('a request target that does not parse is a 400 and the guard stays up', async () => {
    // fetch() will not send this; speak HTTP by hand. `new URL('http://[')` throws.
    const port = Number(new URL(guard.url).port)
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET http://[ HTTP/1.1\r\nHost: guard\r\nConnection: close\r\n\r\n')
      })
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString()
      })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
    })
    assert.match(raw, /^HTTP\/1\.1 400 /)
    assert.equal((await fetch(`${guard.url}/healthz`)).status, 200, 'still serving afterwards')
  })
})

describe('health', () => {
  test('healthz is always ok; readyz follows the price', async () => {
    assert.equal((await fetch(`${guard.url}/healthz`)).status, 200)
    const ready = await fetch(`${guard.url}/readyz`)
    assert.equal(ready.status, 200)
    const body = (await ready.json()) as Record<string, unknown>
    assert.equal(body['status'], 'ready')
    assert.equal(body['configSha256'], 'cafe')
    assert.match(String(body['cosignerKeyFingerprint']), /^sha256:[0-9a-f]{64}$/)
    assert.match(String(body['handlerKeyFingerprint']), /^sha256:[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(body).includes('PRIVATE'), 'no key material in the body')

    price = null
    const notReady = await fetch(`${guard.url}/readyz`)
    assert.equal(notReady.status, 503)
    price = PRICE
  })

  test('the audit log never carries the token or key material', () => {
    const all = lines.join('\n')
    assert.ok(!all.includes('eyJ'), 'no JWT fragments in logs')
    assert.ok(!all.includes('PRIVATE KEY'))
  })
})
