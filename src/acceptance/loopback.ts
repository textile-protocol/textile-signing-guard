// A guard on 127.0.0.1 with throwaway keys: the same decision code and HTTP
// front door as production, driven by the acceptance CLI and the tests.

import { generateKeyPair, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { type AuditLog, createAuditLog } from '../audit.js'
import { createGuardServer, type GuardRuntime } from '../callback/server.js'
import type { GuardConfig } from '../config.js'
import type { PriceSnapshot } from '../price/reference.js'
import type { Clock } from '../types.js'

export type KeyPair = { publicKey: KeyObject; privateKey: KeyObject }

const generate = promisify(generateKeyPair)

/** RSA 2048, the size Fireblocks asks for. Off the main thread. */
export const generateRsaKeyPair = (): Promise<KeyPair> => generate('rsa', { modulusLength: 2048 })

export type LoopbackGuard = {
  url: string
  cosigner: KeyPair
  handler: KeyPair
  close: () => Promise<void>
}

export type LoopbackOptions = {
  config: GuardConfig
  price: () => PriceSnapshot | null
  configSha256?: string
  version?: string
  now?: Clock
  log?: AuditLog
}

export async function startLoopbackGuard(opts: LoopbackOptions): Promise<LoopbackGuard> {
  const [cosigner, handler] = await Promise.all([generateRsaKeyPair(), generateRsaKeyPair()])
  const rt: GuardRuntime = {
    config: opts.config,
    configSha256: opts.configSha256 ?? 'loopback',
    cosignerPublicKey: cosigner.publicKey,
    handlerPrivateKey: handler.privateKey,
    price: opts.price,
    now: opts.now ?? Date.now,
    log: opts.log ?? createAuditLog(() => {}),
    version: opts.version ?? 'loopback',
  }
  const server = createGuardServer(rt, null)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    cosigner,
    handler,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
