import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, test } from 'node:test'
import { loadRsaPrivateKey, loadRsaPublicKey, signRs256, verifyRs256 } from '../../src/callback/jwt.js'
import { rsaPair } from '../helpers.js'

const NOW = 1_800_000_000_000
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

describe('RS256 JWT', () => {
  const { publicKey, privateKey } = rsaPair()

  test('a token signed with the key verifies and yields the payload', () => {
    const token = signRs256({ requestId: 'r1', operation: 'TYPED_MESSAGE' }, privateKey)
    const r = verifyRs256(token, publicKey, NOW)
    assert.ok(r.ok)
    assert.equal(r.value.payload['requestId'], 'r1')
    assert.equal(r.value.header['alg'], 'RS256')
  })

  test('a token signed with another key is refused', () => {
    const other = rsaPair()
    const token = signRs256({ requestId: 'r1' }, other.privateKey)
    const r = verifyRs256(token, publicKey, NOW)
    assert.ok(!r.ok)
    assert.match(r.error, /does not verify/)
  })

  test('a tampered payload is refused', () => {
    const token = signRs256({ requestId: 'r1', action: 'REJECT' }, privateKey)
    const [h, , s] = token.split('.') as [string, string, string]
    const forged = `${h}.${b64(JSON.stringify({ requestId: 'r1', action: 'APPROVE' }))}.${s}`
    assert.ok(!verifyRs256(forged, publicKey, NOW).ok)
  })

  test('alg none and any non-RS256 alg are refused before the signature is checked', () => {
    const payload = b64(JSON.stringify({ requestId: 'r1' }))
    for (const alg of ['none', 'HS256', 'RS512', 'ES256', 'PS256']) {
      const token = `${b64(JSON.stringify({ alg, typ: 'JWT' }))}.${payload}.AAAA`
      const r = verifyRs256(token, publicKey, NOW)
      assert.ok(!r.ok)
      assert.match(r.error, /alg must be RS256/, alg)
    }
  })

  test('malformed tokens are refused', () => {
    for (const bad of ['', 'a.b', 'a.b.c.d', 'not a jwt', '..', `${b64('{}')}.${b64('[]')}.AAAA`]) {
      assert.ok(!verifyRs256(bad, publicKey, NOW).ok, JSON.stringify(bad))
    }
  })

  test('exp and nbf are honoured when present, with skew', () => {
    const now = Math.floor(NOW / 1000)
    assert.ok(!verifyRs256(signRs256({ exp: now - 120 }, privateKey), publicKey, NOW).ok)
    assert.ok(verifyRs256(signRs256({ exp: now - 30 }, privateKey), publicKey, NOW).ok, 'inside skew')
    assert.ok(!verifyRs256(signRs256({ nbf: now + 120 }, privateKey), publicKey, NOW).ok)
    assert.ok(verifyRs256(signRs256({ nbf: now + 30 }, privateKey), publicKey, NOW).ok, 'inside skew')
    assert.ok(verifyRs256(signRs256({}, privateKey), publicKey, NOW).ok, 'absent claims are fine')
  })

  test('key loaders refuse small RSA keys and non-RSA keys', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 })
    assert.ok(!loadRsaPublicKey(small.publicKey.export({ type: 'spki', format: 'pem' }) as string).ok)
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    assert.ok(!loadRsaPublicKey(ec.publicKey.export({ type: 'spki', format: 'pem' }) as string).ok)
    assert.ok(!loadRsaPrivateKey(ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).ok)
    assert.ok(!loadRsaPublicKey('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----').ok)
    assert.ok(loadRsaPublicKey(publicKey.export({ type: 'spki', format: 'pem' }) as string).ok)
    assert.ok(loadRsaPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).ok)
  })
})
