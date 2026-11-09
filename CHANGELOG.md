# Changelog

Notable changes to the Signing Guard, newest first. Each release ships as the image `ghcr.io/textile-protocol/textile-signing-guard`, which operators pin by digest. [docs/operations.md](docs/operations.md) explains how to verify an image and upgrade.

## 0.2.0

First public release. With a correct config, Stitch's orders and venue messages are approved exactly as before. This release adds defence in depth from a full security review, makes configuration mistakes visible before go-live, and opens the code for external review.

### Before you upgrade

Two config changes. The guard refuses to start without them, and `check-config` names what is missing.

- Add `price.min_price` and `price.max_price`, the plausible range for the reference price in quote per 1 base. The example uses 12 and 24 for USDC/ZARU.
- If `allow.erc20_approve_permit2` is on, set `vault.fireblocks_vault_account_id`.

Then run `check-config` and the acceptance suite against the new image, as for any upgrade.

### Security

The review covered every source file, the container image and the dependency tree, in two passes: a line-by-line read and an adversarial pass that ran probes against the compiled guard. It considered five attackers: a holder of the bot's Fireblocks API credential, someone on the network path, anyone who can reach the port, a faulty price source and an operator making a config mistake. Neither pass found a way for the credential holder to obtain a signature outside the policy from a correctly configured guard.

This release closes the gaps the review found around the price source, configuration and resource limits. Each change has a regression test and an entry in [docs/audit.md](docs/audit.md).

- The reference price must fall inside the configured range. This catches an inverted, mis-scaled or manipulated source (SG-01).
- `check-config` and the startup log print each token's decimals, each cap in base units and the price orientation, so a wrong decimal or a swapped pair shows up before go-live (SG-02).
- Tighter limits before authentication: 256 KiB request bodies (was 1 MiB), 256 connections, request timeouts enforced every second, and a 10 second TLS handshake limit (SG-03).
- The price fetch refuses redirects and reads at most 64 KiB (SG-04).
- Stricter typed-data parsing. A `__proto__` type name can no longer slip past the exact type match, and arrays over 8 entries and integers over 78 digits are refused before hashing (SG-05, SG-07, SG-12).
- The ERC-20 approve opt-in requires a stated zero native value and a pinned vault account (SG-06).
- Request values echoed into rejection reasons and logs are length-limited, and a decision's logged action and reason cannot be overwritten (SG-08).
- The configuration-change route always rejects a transaction payload, including with `config_change_action: IGNORE` (SG-09).

### Distribution

- Releases are built and published by this repository's own release workflow as `ghcr.io/textile-protocol/textile-signing-guard`, for linux/amd64 and linux/arm64. Each GitHub release lists the digest, and each image carries a build provenance attestation that `gh attestation verify` checks against this repository. Builds before 0.2.0 were published as `ghcr.io/textile-protocol/signing-guard`; digests pinned there keep working.
- `quickstart/` runs the guard behind Caddy with automatic HTTPS and an IP allowlist for the co-signer, so a new operator can go from a fresh server to a running guard with one compose file.

### Dependencies

- viem 2.39.0 to 2.57.4, which brings `ws` 8.21.0 and clears two advisories against 8.18.3 (GHSA-96hv-2xvq-fx4p, GHSA-58qx-3vcg-4xpx). The guard never opens a websocket, so neither was reachable (SG-17). EIP-712 hashing is unchanged: the Stitch fixtures still match the digests computed by Stitch's own Rust code.
- Node 22 or later. The image runs Node 24.

### Project

- Sources are organised into `callback/`, `policy/`, `price/` and `acceptance/`, and the tests follow the same layout.
- Reference documentation in `docs/` for the policy rules, configuration and operations, a security policy in `SECURITY.md`, and the review record in `docs/audit.md`.
- A [wiki](https://github.com/textile-protocol/textile-signing-guard/wiki) that explains how the guard works and how to run it, in three short pages.
- 137 tests, up from 123. The image build runs the full suite, so an image that fails a test is never produced.

## 0.1.0

First release.

- Fireblocks API Co-Signer callback handler using the JWT flow, RS256 in both directions.
- Policy for Permit2 orders (tokens, recipient, reactor, size cap, deadline and price band), the Textile venue's `MakerSession` and `MakerEnroll`, an optional `SignerCheck` and an optional ERC-20 approve to Permit2.
- EIP-712 messages pinned to the exact shapes Stitch produces and re-hashed, with digest parity tested against Stitch's own code.
- Reference price from the operator's Luno ticker, compared with exact rational arithmetic.
- Fail-closed defaults, strict config validation, and a JSON audit log of every decision.
- Distroless, read-only, non-root image, and an acceptance suite that produces a sign-off report.
