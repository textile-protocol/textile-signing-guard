#!/usr/bin/env node
// Entry point: `serve`, `check-config`, `healthcheck`, `acceptance`, `version`.
//
// Each command imports what it needs when it runs. The Docker HEALTHCHECK
// spawns `healthcheck` every 30 seconds, and it only has to read the listen
// address and GET /readyz, so it must not pay for loading viem and the policy.

import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { parseArgs } from 'node:util'
import { errorMessage, isRecord, type Result } from './types.js'

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const USAGE = `signing-guard <command> [options]

Commands
  serve         --config <file>                 run the callback handler
  check-config  --config <file>                 validate the config and keys, print a summary
  healthcheck   --config <file>                 exit 0 when the local guard reports ready
  acceptance    --config <file> [--json <out>]  run the acceptance suite against a guard started
                                                from this config (ephemeral keys, loopback)
  acceptance    --config <file> --url <https://guard> --cosigner-private-key <pem>
                --handler-public-key <pem> [--json <out>]
                                                run the suite against a running guard that trusts
                                                the given co-signer key
  version
`

const fail = (msg: string): never => {
  process.stderr.write(`signing-guard: ${msg}\n`)
  process.exit(1)
}

const unwrap = <T>(r: Result<T>): T => (r.ok ? r.value : fail(r.error))

const readFile = (path: string, what: string): Buffer => {
  try {
    return readFileSync(path)
  } catch (e) {
    return fail(`cannot read ${what} ${path}: ${errorMessage(e)}`)
  }
}

const readPem = (path: string, what: string): string => readFile(path, what).toString('utf8')

// --- serve and check-config --------------------------------------------------

/** Config, keys and TLS material, validated. Any problem exits before anything listens. */
const loadGuard = async (configPath: string) => {
  const [{ describeConfig, loadConfigFile }, { loadRsaPrivateKey, loadRsaPublicKey }, { keyFingerprint }] = await Promise.all([
    import('./config.js'),
    import('./callback/jwt.js'),
    import('./callback/server.js'),
  ])
  const loaded = unwrap(loadConfigFile(configPath))
  const { config } = loaded
  const cosignerPublicKey = unwrap(loadRsaPublicKey(readPem(config.keys.cosignerPublicKeyFile, 'co-signer public key')))
  const handlerPrivateKey = unwrap(loadRsaPrivateKey(readPem(config.keys.handlerPrivateKeyFile, 'handler private key')))
  const tls = config.listen.tls
    ? { cert: readFile(config.listen.tls.certFile, 'TLS certificate'), key: readFile(config.listen.tls.keyFile, 'TLS key') }
    : null
  const summary = {
    version: VERSION,
    configPath: loaded.path,
    configSha256: loaded.sha256,
    chainId: config.chainId,
    vault: config.vault.address,
    reactor: config.order.reactor,
    ...describeConfig(config),
    allow: Object.entries(config.allow)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(','),
    cosignerKeyFingerprint: keyFingerprint(cosignerPublicKey),
    handlerKeyFingerprint: keyFingerprint(handlerPrivateKey),
    listen: `${config.listen.host}:${config.listen.port} ${config.listen.tls ? 'https' : 'http (behind TLS proxy)'}`,
  }
  return { loaded, cosignerPublicKey, handlerPrivateKey, tls, summary }
}

const serve = async (configPath: string) => {
  const guard = await loadGuard(configPath)
  const [{ stdoutAuditLog }, { createLunoFetcher }, { createPricePoller }, { createGuardServer }] = await Promise.all([
    import('./audit.js'),
    import('./price/luno.js'),
    import('./price/reference.js'),
    import('./callback/server.js'),
  ])
  const { config } = guard.loaded
  const log = stdoutAuditLog()
  const poller = createPricePoller(createLunoFetcher(config.price, fetch, Date.now), config.price.refreshSecs * 1000, (event, fields) =>
    event === 'price_error' ? log.error(event, fields) : log.info(event, fields)
  )
  const server = createGuardServer(
    {
      config,
      configSha256: guard.loaded.sha256,
      cosignerPublicKey: guard.cosignerPublicKey,
      handlerPrivateKey: guard.handlerPrivateKey,
      price: poller.current,
      now: Date.now,
      log,
      version: VERSION,
    },
    guard.tls
  )
  // Listening does not wait for the first price: orders are rejected with
  // price_unavailable and /readyz is 503 until a snapshot lands.
  await Promise.all([
    poller.start(),
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.listen.port, config.listen.host, () => resolve())
    }),
  ])
  log.info('startup', guard.summary)
  const shutdown = (signal: string) => {
    log.info('shutdown', { signal })
    poller.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

const checkConfig = async (configPath: string) => {
  const guard = await loadGuard(configPath)
  process.stdout.write(`${JSON.stringify(guard.summary, null, 2)}\n`)
}

// --- healthcheck -------------------------------------------------------------

/** Just the listen block, read without the full validator: `serve` already validated this file. */
const readListen = (configPath: string): { host: string; port: number; tls: boolean } => {
  const doc: unknown = JSON.parse(readFile(configPath, 'config').toString('utf8'))
  const listen = isRecord(doc) ? doc['listen'] : undefined
  if (!isRecord(listen) || typeof listen['host'] !== 'string' || typeof listen['port'] !== 'number') {
    return fail('config has no usable listen block')
  }
  return { host: listen['host'], port: listen['port'], tls: isRecord(listen['tls']) }
}

const healthcheck = async (configPath: string) => {
  const listen = readListen(configPath)
  const host = listen.host === '0.0.0.0' || listen.host === '::' ? '127.0.0.1' : listen.host
  const client = listen.tls ? https : http
  const status = await new Promise<number>((resolve) => {
    const req = client.request(
      { host, port: listen.port, path: '/readyz', method: 'GET', timeout: 3_000, rejectUnauthorized: false },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', () => resolve(0))
    req.on('timeout', () => {
      req.destroy()
      resolve(0)
    })
    req.end()
  })
  process.exit(status === 200 ? 0 : 1)
}

// --- acceptance ----------------------------------------------------------------

type AcceptanceArgs = { config: string; url?: string; cosignerKey?: string; handlerKey?: string; json?: string }

const acceptance = async (args: AcceptanceArgs) => {
  const [
    { loadConfigFile },
    { createLunoFetcher },
    { buildCases },
    { renderReport, runCases },
    loopback,
    { loadRsaPrivateKey, loadRsaPublicKey },
  ] = await Promise.all([
    import('./config.js'),
    import('./price/luno.js'),
    import('./acceptance/cases.js'),
    import('./acceptance/run.js'),
    import('./acceptance/loopback.js'),
    import('./callback/jwt.js'),
  ])
  const loaded = unwrap(loadConfigFile(args.config))
  const { config } = loaded
  const remote = args.url !== undefined
  if (remote && (!args.cosignerKey || !args.handlerKey)) fail('--url needs --cosigner-private-key and --handler-public-key')

  const [priceResult, wrongKey] = await Promise.all([createLunoFetcher(config.price, fetch, Date.now)(), loopback.generateRsaKeyPair()])
  const price = priceResult.ok ? priceResult.value : null
  // Without a price the order cases cannot sit on the mid. They are built at
  // 1:1 and the report shows them failing with price_unavailable, which is
  // what the operator needs to see about their ticker.
  const nowMs = Date.now()
  const cases = buildCases(config, price?.mid ?? { num: 1n, den: 1n }, nowMs)

  const target = remote
    ? {
        url: args.url as string,
        cosignerPrivateKey: unwrap(loadRsaPrivateKey(readPem(args.cosignerKey as string, 'co-signer private key'))),
        handlerPublicKey: unwrap(loadRsaPublicKey(readPem(args.handlerKey as string, 'handler public key'))),
        close: async () => {},
      }
    : await loopback
        .startLoopbackGuard({ config, configSha256: loaded.sha256, price: () => price, version: VERSION })
        .then((g) => ({ url: g.url, cosignerPrivateKey: g.cosigner.privateKey, handlerPublicKey: g.handler.publicKey, close: g.close }))

  const results = await runCases(cases, { ...target, wrongKey: wrongKey.privateKey, now: Date.now })
  await target.close()

  const meta = {
    'guard version': VERSION,
    'image digest': process.env['GUARD_IMAGE_DIGEST'] ?? '(set GUARD_IMAGE_DIGEST to record it)',
    mode: remote ? `remote guard at ${args.url}` : 'guard started from this config on loopback with ephemeral keys',
    'config file': loaded.path,
    'config sha256': loaded.sha256,
    'reference price': price
      ? `${price.display} ${config.price.quoteToken} per ${config.price.baseToken} from ${config.price.url}`
      : `UNAVAILABLE: ${priceResult.ok ? '' : priceResult.error}`,
    'run at': new Date(nowMs).toISOString(),
  }
  process.stdout.write(`${renderReport(meta, results)}\n`)
  if (args.json) writeFileSync(args.json, `${JSON.stringify({ meta, results }, null, 2)}\n`)
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

// --- main --------------------------------------------------------------------------

const main = async () => {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      url: { type: 'string' },
      'cosigner-private-key': { type: 'string' },
      'handler-public-key': { type: 'string' },
      json: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0]
  if (values.help || command === undefined) {
    process.stdout.write(USAGE)
    process.exit(command === undefined ? 1 : 0)
  }
  const needConfig = () => values.config ?? fail('--config <file> is required')
  switch (command) {
    case 'serve':
      return serve(needConfig())
    case 'check-config':
      return checkConfig(needConfig())
    case 'healthcheck':
      return healthcheck(needConfig())
    case 'acceptance': {
      const opts: AcceptanceArgs = { config: needConfig() }
      if (values.url !== undefined) opts.url = values.url
      if (values['cosigner-private-key'] !== undefined) opts.cosignerKey = values['cosigner-private-key']
      if (values['handler-public-key'] !== undefined) opts.handlerKey = values['handler-public-key']
      if (values.json !== undefined) opts.json = values.json
      return acceptance(opts)
    }
    case 'version':
      process.stdout.write(`${VERSION}\n`)
      return
    default:
      return fail(`unknown command ${command}\n${USAGE}`)
  }
}

main().catch((e: unknown) => fail(errorMessage(e)))
