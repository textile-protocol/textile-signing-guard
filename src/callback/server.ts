// HTTP(S) front door: the two Fireblocks callback routes plus health probes.
// Everything that can go wrong before a decision is a refusal the co-signer
// treats as a failed request: bad method, oversized body, JWT that does not
// verify. A request that verifies but does not parse gets a signed REJECT.

import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import type { AuditLog } from '../audit.js'
import type { GuardConfig } from '../config.js'
import { decide, decideConfigChange } from '../policy/decide.js'
import { type Decision, reject } from '../policy/decision.js'
import { fetchAgeMs, type PriceSnapshot, sourceAgeMs, staleness } from '../price/reference.js'
import { clip, type Clock, errorMessage } from '../types.js'
import { signRs256, verifyRs256 } from './jwt.js'
import { parseSignRequest, requestIdOf } from './request.js'

export const TX_SIGN_ROUTE = '/v2/tx_sign_request'
export const CONFIG_CHANGE_ROUTE = '/v2/config_change_sign_request'
/** A signed order request is a few KB. The cap bounds what a connection can
 * make the guard buffer before the JWT is checked. */
export const MAX_BODY_BYTES = 256 * 1024
/** With MAX_BODY_BYTES, bounds unauthenticated buffering to 64 MiB. */
const MAX_CONNECTIONS = 256
/** Reasons echo request fields; keep what goes back to Fireblocks short. */
const MAX_REJECTION_REASON = 500

export type GuardRuntime = {
  config: GuardConfig
  configSha256: string
  cosignerPublicKey: KeyObject
  handlerPrivateKey: KeyObject
  price: () => PriceSnapshot | null
  now: Clock
  log: AuditLog
  version: string
}

/** sha256 of the SPKI DER, so two parties can compare keys without sharing them. */
export function keyFingerprint(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key
  return `sha256:${createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex')}`
}

/** The whole body, or `null` when it is over the limit or unreadable. An
 * oversized body is drained rather than cut off so the 413 reaches the client. */
const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (overflow || size > limit) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const sendText = (res: http.ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** The signed answer. `rejectionReason` only rides on a REJECT. */
const responseClaims = (requestId: string, decision: Decision): Record<string, unknown> =>
  decision.action === 'REJECT'
    ? { action: 'REJECT', requestId, rejectionReason: clip(`${decision.reason}: ${decision.detail}`, MAX_REJECTION_REASON) }
    : { action: decision.action, requestId }

const readiness = (rt: GuardRuntime): { ready: boolean; body: Record<string, unknown> } => {
  const snapshot = rt.price()
  const now = rt.now()
  const stale = staleness(snapshot, now, rt.config.price)
  const { maxAgeSecs, maxSourceAgeSecs, pair } = rt.config.price
  return {
    ready: stale === null,
    body: {
      status: stale === null ? 'ready' : 'not_ready',
      ...(stale === null ? {} : { priceProblem: stale }),
      version: rt.version,
      configSha256: rt.configSha256,
      cosignerKeyFingerprint: keyFingerprint(rt.cosignerPublicKey),
      handlerKeyFingerprint: keyFingerprint(rt.handlerPrivateKey),
      price: {
        pair,
        mid: snapshot?.display ?? null,
        fetchAgeSecs: snapshot ? Math.floor(fetchAgeMs(snapshot, now) / 1000) : null,
        sourceAgeSecs: snapshot ? Math.floor(sourceAgeMs(snapshot, now) / 1000) : null,
        maxAgeSecs,
        maxSourceAgeSecs,
      },
    },
  }
}

const handleSignRoute = async (rt: GuardRuntime, route: string, req: http.IncomingMessage, res: http.ServerResponse) => {
  const body = await readBody(req, MAX_BODY_BYTES)
  if (body === null) {
    rt.log.error('request_refused', { route, reason: 'body_too_large_or_unreadable' })
    sendText(res, 413, 'body too large')
    return
  }
  const verified = verifyRs256(body.toString('utf8'), rt.cosignerPublicKey, rt.now(), rt.config.jwt.clockSkewSecs)
  if (!verified.ok) {
    rt.log.error('request_unauthenticated', { route, reason: verified.error })
    sendText(res, 401, 'unauthenticated')
    return
  }
  const payload = verified.value.payload
  const requestId = requestIdOf(payload)
  if (requestId === null) {
    rt.log.error('request_refused', { route, reason: 'no requestId' })
    sendText(res, 400, 'no requestId')
    return
  }

  /** Log the decision, sign it, send it. Every answer leaves through here. */
  const answer = (ids: { txId: string | null; operation: string | null }, decision: Decision) => {
    rt.log.decision({ requestId, route, ...ids }, decision)
    sendText(res, 200, signRs256(responseClaims(requestId, decision), rt.handlerPrivateKey))
  }

  if (route === CONFIG_CHANGE_ROUTE) {
    answer({ txId: null, operation: 'CONFIG_CHANGE' }, decideConfigChange(payload, rt.config))
    return
  }
  const parsed = parseSignRequest(payload)
  if (!parsed.ok) {
    answer({ txId: null, operation: null }, reject('malformed_request', parsed.error))
    return
  }
  const request = parsed.value
  answer(
    { txId: request.txId, operation: request.operation },
    decide(request, { config: rt.config, nowMs: rt.now(), price: rt.price() })
  )
}

/** The path of the request target, or `null` when it does not parse. Node
 * accepts absolute-form targets like `GET http://[ HTTP/1.1`, and `new URL`
 * throws on them; that must be a 400, not an exception. */
const routeOf = (target: string | undefined): string | null => {
  try {
    return new URL(target ?? '/', 'http://guard.invalid').pathname
  } catch {
    return null
  }
}

const route = (rt: GuardRuntime, req: http.IncomingMessage, res: http.ServerResponse): void => {
  const path = routeOf(req.url)
  if (path === null) {
    rt.log.error('request_refused', { route: null, reason: 'unparseable request target' })
    sendText(res, 400, 'bad request')
    return
  }
  if (path === TX_SIGN_ROUTE || path === CONFIG_CHANGE_ROUTE) {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed')
      return
    }
    void handleSignRoute(rt, path, req, res).catch((e: unknown) => {
      rt.log.error('handler_error', { route: path, error: errorMessage(e) })
      if (!res.headersSent) sendText(res, 500, 'internal error')
    })
    return
  }
  if (path !== '/healthz' && path !== '/readyz') {
    sendText(res, 404, 'not found')
    return
  }
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed')
    return
  }
  if (path === '/healthz') {
    sendJson(res, 200, { status: 'ok', version: rt.version })
    return
  }
  const r = readiness(rt)
  sendJson(res, r.ready ? 200 : 503, r.body)
}

/** The listener never throws: a request that breaks routing gets a 500 and
 * the process stays up. Taking the guard down is taking all signing down. */
const createRequestListener = (rt: GuardRuntime): http.RequestListener => (req, res) => {
  try {
    route(rt, req, res)
  } catch (e) {
    rt.log.error('handler_error', { route: req.url ?? null, error: errorMessage(e) })
    if (!res.headersSent) sendText(res, 500, 'internal error')
  }
}

export type TlsMaterial = { cert: Buffer; key: Buffer }

export function createGuardServer(rt: GuardRuntime, tls: TlsMaterial | null): http.Server {
  const listener = createRequestListener(rt)
  // The co-signer gives us 30 s in total. Anything slower than these limits is
  // a broken or hostile client, not a slow decision: decisions are in-memory.
  // Node only enforces the header and request timeouts every
  // connectionsCheckingInterval, which defaults to 30 s.
  const limits = { headersTimeout: 10_000, requestTimeout: 15_000, connectionsCheckingInterval: 1_000 }
  const server = tls
    ? https.createServer(
        { ...limits, cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', honorCipherOrder: true, handshakeTimeout: 10_000 },
        listener
      )
    : http.createServer(limits, listener)
  server.keepAliveTimeout = 65_000
  server.maxConnections = MAX_CONNECTIONS
  return server
}
