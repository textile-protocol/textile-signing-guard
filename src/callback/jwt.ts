// RS256 JSON Web Tokens with nothing but node:crypto.
//
// The Fireblocks co-signer signs every callback request as a JWT with its RSA
// private key, and expects the handler's answer as a JWT signed with the
// handler's RSA private key (RS256; ES256 exists on newer co-signers but is
// not supported here). The format is small enough that a dependency would add
// more audit surface than it removes, so this module does exactly one thing:
// RS256, PKCS#1 v1.5, SHA-256. Any other `alg` is refused before the
// signature is even looked at, which rules out `none` and algorithm-confusion
// attacks by construction.

import { createPublicKey, createPrivateKey, sign, verify, constants, KeyObject } from 'node:crypto'
import { err, isRecord, ok, type Result } from '../types.js'

const MIN_RSA_BITS = 2048

const b64url = (buf: Buffer): string => buf.toString('base64url')

const fromB64url = (part: string): Result<Buffer> => {
  // Node accepts both alphabets and ignores padding; be stricter so a token
  // that is not canonical base64url is refused rather than guessed at.
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return err('jwt part is not base64url')
  return ok(Buffer.from(part, 'base64url'))
}

const parseJson = (buf: Buffer): Result<unknown> => {
  try {
    return ok(JSON.parse(buf.toString('utf8')))
  } catch {
    return err('jwt part is not JSON')
  }
}

/** Parse a PEM public key and insist on RSA of a sane size. */
export function loadRsaPublicKey(pem: string): Result<KeyObject> {
  let key: KeyObject
  try {
    key = createPublicKey(pem)
  } catch {
    return err('not a readable PEM public key')
  }
  return checkRsa(key)
}

/** Parse a PEM private key and insist on RSA of a sane size. */
export function loadRsaPrivateKey(pem: string): Result<KeyObject> {
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch {
    return err('not a readable PEM private key')
  }
  return checkRsa(key)
}

const checkRsa = (key: KeyObject): Result<KeyObject> => {
  if (key.asymmetricKeyType !== 'rsa') return err(`key type is ${key.asymmetricKeyType ?? 'unknown'}, need rsa`)
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_RSA_BITS) return err(`RSA modulus is ${bits} bits, need at least ${MIN_RSA_BITS}`)
  return ok(key)
}

export type VerifiedJwt = {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

/**
 * Verify a compact JWT: RS256 only, signature first, then `exp`/`nbf` when
 * present (the co-signer may or may not set them; a present-but-expired token
 * is refused the same way PyJWT does in Fireblocks' reference handler).
 */
export function verifyRs256(
  token: string,
  publicKey: KeyObject,
  nowMs: number,
  clockSkewSecs = 60
): Result<VerifiedJwt> {
  const parts = token.trim().split('.')
  if (parts.length !== 3) return err('jwt must have three parts')
  const [h, p, s] = parts as [string, string, string]
  if (h.length === 0 || p.length === 0 || s.length === 0) return err('jwt has an empty part')

  const headerBytes = fromB64url(h)
  if (!headerBytes.ok) return headerBytes
  const header = parseJson(headerBytes.value)
  if (!header.ok) return header
  if (!isRecord(header.value)) return err('jwt header is not an object')
  if (header.value['alg'] !== 'RS256') return err('jwt alg must be RS256')

  const sig = fromB64url(s)
  if (!sig.ok) return sig
  const signed = Buffer.from(`${h}.${p}`, 'ascii')
  let valid = false
  try {
    valid = verify('sha256', signed, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, sig.value)
  } catch {
    valid = false
  }
  if (!valid) return err('jwt signature does not verify against the co-signer public key')

  const payloadBytes = fromB64url(p)
  if (!payloadBytes.ok) return payloadBytes
  const payload = parseJson(payloadBytes.value)
  if (!payload.ok) return payload
  if (!isRecord(payload.value)) return err('jwt payload is not an object')

  const nowSecs = Math.floor(nowMs / 1000)
  const exp = payload.value['exp']
  if (exp !== undefined) {
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return err('jwt exp is not a number')
    if (nowSecs > exp + clockSkewSecs) return err('jwt has expired')
  }
  const nbf = payload.value['nbf']
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) return err('jwt nbf is not a number')
    if (nowSecs < nbf - clockSkewSecs) return err('jwt is not valid yet')
  }
  return ok({ header: header.value, payload: payload.value })
}

const RS256_HEADER = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8'))

/** Produce a compact RS256 JWT over `payload`. */
export function signRs256(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = RS256_HEADER
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signed = Buffer.from(`${header}.${body}`, 'ascii')
  const sig = sign('sha256', signed, { key: privateKey, padding: constants.RSA_PKCS1_PADDING })
  return `${header}.${body}.${b64url(sig)}`
}
