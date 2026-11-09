# Security

The Signing Guard decides which signatures a Fireblocks co-signer produces for a vault. A bug that turns a REJECT into an APPROVE can move the vault's funds, so we want to hear about it before anyone else does.

## Reporting a vulnerability

Email security@textilecredit.com, or use GitHub's private vulnerability reporting on this repository if it is enabled. Do not open a public issue, pull request or discussion.

Include what an attacker needs (for example: the bot's API credential, network position between co-signer and guard, control of the price source), the request or config that triggers it, and ideally a failing test. Redact real vault addresses, keys and Fireblocks ids.

We acknowledge within two business days, give an initial assessment within five, and agree a disclosure date with you. Please don't disclose until a fixed image is published and operators have had time to move to it. We credit reporters unless they prefer otherwise.

## Scope

In scope: everything in this repository that runs or ships, meaning the decision code, JWT handling, config parsing, the price fetcher, the CLI, the Dockerfile and the published image `ghcr.io/textile-protocol/textile-signing-guard` and the workflow that builds it.

Out of scope: Fireblocks itself (the co-signer, the TAP, the API), Stitch and the Textile venue and contracts (each has its own repository and policy), and losses the README's "What it does not do" already describes, such as in-band trades by someone holding the bot's credential or a wrong price from the operator's chosen source.

[docs/audit.md](docs/audit.md) lists what has been reviewed so far and what came out of it.
