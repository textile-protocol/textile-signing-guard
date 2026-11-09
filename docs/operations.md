# Operations

## Deployment

The guard needs inbound HTTPS from the co-signer, outbound HTTPS to the price source, the config file, the co-signer's public key, its own private key, and a TLS certificate (or a proxy that has one). Nothing else. It writes nothing to disk.

Only the co-signer should be able to reach the port. Anyone who can connect can't get a decision without a co-signer JWT, but they can use up connections and fill the logs. Publish the port on the interface the co-signer uses and firewall the rest.

### Keys

Generate the handler key on the operator's side; Textile never sees it:

```sh
openssl genrsa -out handler_private.pem 2048
openssl rsa -in handler_private.pem -pubout -out handler_public.pem
```

Register `handler_public.pem` with the co-signer as the API user's Callback Handler public key, and set the callback URL to the base URL only (the co-signer appends `/v2/tx_sign_request` itself). Get the co-signer's public key from the co-signer per Fireblocks' maintenance guide and save it as `cosigner_public.pem`. Keys are RSA only: Fireblocks also allows ES256 on recent co-signers, but one algorithm is one less thing to review.

### Running the container

The simplest setup is `quickstart/`: the guard on plain HTTP inside a compose network, behind Caddy, which terminates TLS with a Let's Encrypt certificate and lets only `COSIGNER_IP` through. The wiki's [Getting started](https://github.com/textile-protocol/textile-signing-guard/wiki/Getting-started) page walks through it.

To serve TLS from the guard itself with your own certificate, use `docker-compose.example.yml` and lay out the config directory like this, readable by uid 65532, with the `tls` and `keys` paths in `guard.json` pointing at `/config/...`:

```
config/
  guard.json
  keys/cosigner_public.pem
  keys/handler_private.pem
  tls/server.crt
  tls/server.key
```

Either way the image runs read-only, as the distroless `nonroot` user (uid 65532), with all capabilities dropped and only the config directory mounted. It has no shell and no package manager; its health check is the binary probing its own `/readyz`.

### Pinning the image

Releases are built by this repository's release workflow and published as `ghcr.io/textile-protocol/textile-signing-guard` for linux/amd64 and linux/arm64. Each GitHub release lists the image digest. Run that digest, never a tag, and check that it was built here from the tagged commit:

```sh
gh attestation verify oci://ghcr.io/textile-protocol/textile-signing-guard@sha256:<digest> \
  --repo textile-protocol/textile-signing-guard
```

The digest in the compose file is the one that runs. For an independent check, build the image yourself from the tagged source with `docker build .`: the Dockerfile pins both base images by digest, `npm ci` installs exactly the lockfile, and the whole test suite runs inside the build. Image bytes are not bit-for-bit reproducible (file timestamps differ), so compare the installed dependency tree (`npm ls --all`) and the test output rather than the digest.

Builds before 0.2.0 were published as `ghcr.io/textile-protocol/signing-guard`. Digests pinned there keep working.

## Health

- `GET /healthz`: 200 while the process is up. Use it for liveness.
- `GET /readyz`: 200 when the reference price is fresh under both limits, otherwise 503 with the reason. The body also carries the guard version, the config SHA-256, and the SHA-256 fingerprints (of the SPKI DER) of the co-signer key and the handler key, so both parties can confirm which config and keys are live without sharing them.

Alert on `/readyz` going 503: while it is, every order is rejected with `price_stale` or `price_unavailable`. Orchestrators that restart unhealthy containers should probe `/healthz`, or a ticker outage turns into a restart loop.

## Logs

One JSON object per line on stdout. Events: `startup` (config hash, key fingerprints, listen address, allowed kinds), `price_update`, `price_error`, `decision`, `request_unauthenticated`, `request_refused`, `handler_error`, `shutdown`. A `decision` line has `requestId`, `txId`, `operation`, `action`, `reason`, `detail`, and for an order `kind`, `digest`, `direction`, `inputToken`, `inputAmount`, `outputToken`, `outputAmount`, `recipient`, `swapper`, `nonce`, `deadline`, `impliedPrice`, `referencePrice`, `deviationBps`. String values are clipped at 512 characters. Ship the logs off the host and keep them: they are the record of what the guard approved, and local rotation (20 x 50 MB in the compose example) is not an archive.

## Upgrading

Each release has a GitHub release with the new image digest, and [CHANGELOG.md](../CHANGELOG.md) says what changed. The operator reviews the diff, rebuilds or pulls by digest, runs `check-config` and the acceptance suite against the new image, and only then changes the digest in the compose file. There is no auto-update path, by design. A config change follows the same steps without the image step.

## Acceptance suite

`signing-guard acceptance` sends a compliant request of every allowed kind, plus non-compliant ones that each break one rule (wrong recipient, extra output, foreign token, EIP-2612 permit, domain spoofs, out-of-band prices in both directions, far deadline, oversized amount, wrong venue domain, EIP-191 message, RAW and TRANSFER operations, an unknown operation, contract calls, a configuration change, a JWT from the wrong key, a body that is not a JWT) and prints a pass/fail report. Expectations follow the config under test, so a policy with `allow.signer_check` on expects that case to pass.

By default it starts a guard from the given config on loopback with throwaway keys and runs the suite against it. The reference price comes from the real ticker, so a network or price problem fails the compliant cases, which is what the operator needs to see:

```sh
docker run --rm --read-only --user 65532:65532 --cap-drop ALL -v "$PWD/config:/config:ro" \
  -e GUARD_IMAGE_DIGEST=sha256:<digest> \
  ghcr.io/textile-protocol/textile-signing-guard@sha256:<digest> acceptance --config /config/guard.json --json /dev/stdout
```

Remote mode targets a running guard that trusts a test co-signer key, for a staging instance:

```sh
signing-guard acceptance --config guard.json --url https://guard.staging:8443 \
  --cosigner-private-key test_cosigner_private.pem --handler-public-key handler_public.pem
```

The production guard trusts only the real co-signer's key, which never leaves the co-signer, so the production instance cannot be driven by this command. What it proves is that the exact image and config in production make the right decisions; `/readyz` proves which config and keys the production instance loaded. The live end-to-end check is a non-compliant typed message submitted through the Fireblocks API with the bot's API user, which must fail with the `AUTHORIZATION_FAILED` sub-status, and the first real quote, which must sign. Run the suite at go-live and at least monthly, and keep the `--json` output as the sign-off record.

## What to confirm on a live workspace

The Fireblocks documentation leaves these open. Each has a safe default in the code. The Fireblocks Developer Sandbox does not offer a customer-run co-signer, so check them on a staging or production workspace with a test vault.

1. Whether `rawTx[].payload` is sent for `TYPED_MESSAGE` requests on your workspace. If it is, turn on `signing_payload.require`.
2. Whether `sourceType` reads `VAULT` or `VAULT_ACCOUNT` in the callback payload. Both are accepted.
3. Whether the co-signer's JWT carries `exp`. If it does, the guard enforces it with `jwt.clock_skew_secs`.
4. Whether the typed data arrives exactly as the bot sent it (numbers vs decimal strings, address case). The parser accepts both forms for `uint256` and any case for addresses and re-hashes, so a re-serialisation that preserves values is fine. One that changes the `types` map is rejected as `message_kind_not_allowed`.
5. Only with the approve opt-in: the Fireblocks asset id for the chain's native asset in the callback (`BASECHAIN_ETH` on Base), and that `CONTRACT_CALL` requests carry `amountStr`. The guard rejects an approve that does not state its native value.

## Fireblocks references

[Callback Handler authentication](https://developers.fireblocks.com/reference/authenticate), [secure communication options](https://developers.fireblocks.com/reference/cosigner-callbackhandler-secure-communication-authentication), [tx_sign_request payload](https://developers.fireblocks.com/reference/approve-transactions), [response object and the 30 second timeout](https://developers.fireblocks.com/reference/response-object), [config_change_sign_request](https://developers.fireblocks.com/cosigners/callback-handler/approve-configuration-changes), [transaction sub-statuses](https://developers.fireblocks.com/reference/transaction-substatuses), [raw signing objects](https://developers.fireblocks.com/reference/raw-signing-objects), [plugin-based reference handler](https://github.com/fireblocks/plugin-based-callback-handler).
