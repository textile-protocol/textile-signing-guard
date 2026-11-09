# Configuration

One JSON file, mounted read-only. Every key is validated at startup, unknown keys are errors, and the process refuses to start on any problem. `config/guard.example.json` is a complete example for a USDC/ZARU vault on Base; replace `vault.address` and size the caps for your own vault.

| Key | Meaning |
|---|---|
| `listen.host`, `listen.port` | Where to listen. |
| `listen.tls.cert_file`, `listen.tls.key_file` | Serve HTTPS with this certificate. The co-signer needs a certificate signed by a CA it trusts. |
| `listen.plain_http` | Serve plain HTTP instead. Only for a TLS-terminating proxy or sidecar on the same host or pod. Exactly one of `tls` and `plain_http` must be set. |
| `keys.cosigner_public_key_file` | PEM public key of the co-signer (RSA, 2048 bits or more). Verifies incoming JWTs. |
| `keys.handler_private_key_file` | PEM private key of this handler (RSA, 2048 bits or more). Signs responses. Its public key is registered with the co-signer. |
| `vault.address` | The Fireblocks vault's EVM address: swapper, recipient and signing address in every allowed message. |
| `vault.fireblocks_vault_account_id` | The Fireblocks vault account id. When set, requests from any other source are rejected. Required with `allow.erc20_approve_permit2`. |
| `chain_id` | The only chain allowed in domains and messages. |
| `allow.permit2_orders`, `allow.maker_session`, `allow.maker_enroll` | Default on. |
| `allow.signer_check` | Default off. Trading does not need it; with it off, Stitch's panel Verify button fails. |
| `allow.erc20_approve_permit2` | Default off. Allows the one contract call in [policy.md](policy.md#the-approve-opt-in); needs the `approve` section. |
| `order.permit2`, `order.reactor` | Canonical Permit2 and the LimitOrderReactor for the chain. |
| `order.tokens` | Exactly two tokens with `symbol`, `address`, `decimals`. Decimals must match the contract's `decimals()`. |
| `order.validation_contracts` | Allowed `additionalValidationContract` values. Stitch uses the zero address for ladder orders and the venue's PreferredFillerValidation for RFQ orders. Omit the key to skip the check. |
| `order.max_input_amount` | Per-order cap on `permitted.amount`, in whole tokens, per symbol. Required for both tokens. |
| `order.max_lifetime_secs`, `order.clock_skew_secs` | Deadline bound. RFQ orders live as long as the venue's quote TTL; Stitch's ladder orders default to 120 seconds. |
| `price.url`, `price.pair` | Ticker URL (https only) and the `pair` it must report. |
| `price.base_token`, `price.quote_token` | How to read the ticker: quote per 1 base. Both must be configured tokens. |
| `price.max_deviation_bps` | The band, in basis points either side of the reference. |
| `price.min_price`, `price.max_price` | The plausible range for the reference, quote per 1 base, as decimal strings. A ticker mid outside it is refused. Set it wide enough for normal moves and narrow enough that an inverted or mis-scaled price falls outside. Required. |
| `price.max_spread_bps` | Widest bid/ask spread (bps of the mid) the ticker may show before its mid is refused. Default 300. A live book can swing from a few bps to over 100 bps day to day, so a tight limit stops quoting on a thin day; 300 still refuses a broken book. |
| `price.max_age_secs`, `price.max_source_age_secs` | Staleness limits, see [policy.md](policy.md#reference-price). Defaults 60 and 600. |
| `price.refresh_secs`, `price.timeout_ms` | Poller cadence and per-fetch timeout. Defaults 5 and 3000. `refresh_secs` must be below `max_age_secs`. |
| `venue.session_domain_name`, `venue.enroll_domain_name` | `Textile Maker Session (LIVE)` and `Textile Maker Enroll (LIVE)` for production. |
| `venue.funding_wallet` | Defaults to the vault, and for now must equal it. An OperatorVault setup (the Fireblocks key as the vault's strategy signer) also signs `NavAttestation` messages for epoch settlement, which the policy does not include, so the guard would approve orders and block settlement. |
| `venue.max_issued_at_skew_secs` | How far a session or enroll `issuedAt` may be from the guard's clock. Default 300. |
| `approve.max_amount`, `approve.asset_ids` | Caps per token, and the Fireblocks asset ids for the chain's native asset (Base is `BASECHAIN_ETH`), for the approve opt-in. |
| `signing_payload.require` | Reject typed-message requests that carry no `rawTx` payload. Default off. |
| `config_change_action` | `REJECT` (default) or `IGNORE`, which leaves configuration changes to human approvers. |
| `jwt.clock_skew_secs` | Tolerance when the co-signer's JWT carries `exp` or `nbf`. Default 60. |

`signing-guard check-config --config guard.json` validates the file and both key files, and prints a summary with the config's SHA-256 and both key fingerprints. Run it after every edit, and read its `tokens`, `orderCaps` and `reference` lines: they spell out each token's decimals, each cap in atoms and which way the price is read. A wrong `decimals` or a swapped base and quote makes the guard approve the wrong amounts, and the acceptance suite cannot catch it, because it builds its cases from the same config.
