# The Guard Policy

Checks run in the order below. The first one that fails is the reason code in the response's `rejectionReason` and in the audit log. Every value comes from the config file ([configuration.md](configuration.md)).

## Every request

| Rule | Reason code when it fails |
|---|---|
| The request comes from the pinned Fireblocks vault account, when one is configured | `wrong_source` |
| `operation` is `TYPED_MESSAGE`, or `CONTRACT_CALL` with the approve opt-in | `operation_not_allowed` |
| Exactly one message, of type `EIP712`, with well-formed typed data (arrays of at most 8 entries) | `message_count`, `message_type_not_allowed`, `malformed_typed_data` |
| `types` and `primaryType` match one of the four allowed shapes exactly | `message_kind_not_allowed` |
| Every `rawTx[].payload`, if present, equals the recomputed EIP-712 digest | `signing_payload_mismatch`, `signing_payload_missing` |
| The message kind is switched on in `allow` | `kind_not_allowed` |

### Hash and compare

The guard recomputes the EIP-712 digest of the typed data it is asked about (viem `hashTypedData`, with the `EIP712Domain` type taken from the request's own `types`). When the request carries `rawTx[].payload`, every payload must equal that digest. That stops a request whose readable typed data is compliant while the bytes actually signed are something else.

Fireblocks documents `rawTx` as opt-in per workspace and not sent in the EU cloud, so the check runs whenever the field is present, and `signing_payload.require` makes a missing field a rejection too. Turn it on once the first decision logs show the field arriving.

Independently of `rawTx`, the typed data is pinned structurally. `types` has to be exactly one of the four shapes Stitch produces, `EIP712Domain` field list included, and no undeclared or malformed field is tolerated. The fixtures in `test/fixtures/stitch-typed-data.json` were dumped from Stitch's `src/protocol/typed_data.rs` and `src/rfq/order.rs`, and the tests prove the guard's digest equals Stitch's for each. Messages Stitch can sign that the policy does not list (OperatorVault NAV attestations, GMX recall quotes) are rejected as unknown kinds.

## Permit2 orders

`PermitWitnessTransferFrom` with a UniswapX `LimitOrder` witness: the one kind that moves funds.

| Rule | Reason code |
|---|---|
| Domain is `Permit2`, `chainId` is `chain_id`, `verifyingContract` is `order.permit2` | `wrong_domain`, `wrong_chain`, `wrong_verifying_contract` |
| `spender` and `witness.info.reactor` are `order.reactor` | `wrong_spender`, `wrong_reactor` |
| `permitted` matches the witness (token, amount, nonce, deadline) | `permit_witness_mismatch` |
| `witness.info.swapper` and every `witness.outputs[].recipient` are the vault | `wrong_swapper`, `wrong_recipient` |
| Exactly one output | `output_count` |
| Input and output are the two configured tokens, one each, amounts positive | `token_not_allowed`, `zero_amount` |
| `additionalValidationContract` is on the allowlist, when one is configured | `validation_contract_not_allowed` |
| `permitted.amount` is at or under the cap for that token | `amount_over_cap` |
| Deadline is in the future and at most `max_lifetime_secs + clock_skew_secs` ahead | `deadline_passed`, `deadline_too_far` |
| A fresh reference price exists and the order's implied price is within `max_deviation_bps` of it | `price_unavailable`, `price_stale`, `price_out_of_band` |

The band is symmetric: an order that pays the vault far more than the reference is also refused, since that usually means the reference or a token's decimals are wrong. All amount and price arithmetic is exact (bigint rationals, cross-multiplied comparisons); there is no floating point in the decision path. `additionalValidationData` is not inspected: with the allowlisted PreferredFillerValidation contract it only chooses which filler may fill first.

## Venue messages

- `MakerSession`: domain name is `venue.session_domain_name` with version `1`, `signingAddress` is the vault, `issuedAt` (unix ms) is within `venue.max_issued_at_skew_secs` of now.
- `MakerEnroll`: domain name is `venue.enroll_domain_name` with version `1`, both chain ids are `chain_id`, `signingAddress` is the vault, `fundingWallet` is `venue.funding_wallet`, `issuedAt` is within the same skew.
- `SignerCheck`: only with `allow.signer_check` on, and only under the `Stitch Signer Check` domain, version `1`.

Reason codes: `wrong_domain`, `wrong_chain`, `wrong_signing_address`, `wrong_funding_wallet`, `issued_at_skew`.

## The approve opt-in

With `allow.erc20_approve_permit2` on (which requires `vault.fireblocks_vault_account_id`), a `CONTRACT_CALL` passes when: `asset` is in `approve.asset_ids`, `amountStr` is present and zero (and `amount`, if sent, is zero too), `destAddress` is a configured token, and the calldata is exactly `approve(address,uint256)` with the spender `order.permit2` and the amount at or under `approve.max_amount` for that token.

The guard does not read the transaction's fee fields. The network fee of an approved call is bounded by the workspace's fee settings and TAP, not by the guard, so keep the vault's native balance to what gas needs.

Reason codes: `wrong_asset`, `native_value`, `token_not_allowed`, `malformed_call`, `wrong_function`, `wrong_spender`, `amount_over_cap`.

## Configuration changes

`/v2/config_change_sign_request` answers `config_change_action` (REJECT by default, or IGNORE). A payload that carries an `operation` is a transaction, not a configuration change, and is always rejected there: the signed answer names only the `requestId`, so an IGNORE for a transaction must never be produced.

## Reference price

The reference is the mid of bid and ask from the operator's ticker, fetched by a background poller every `price.refresh_secs`. A decision never waits on the network: it reads the latest snapshot. A mid outside `price.min_price` to `price.max_price` is refused like any other bad print, which catches a source quoting the inverse pair, a price off by a power of ten, or one pushed far from reality. Two staleness limits apply, both rejecting when exceeded and both turning `/readyz` 503:

- `max_age_secs`: how long ago the guard last fetched successfully.
- `max_source_age_secs`: how old the ticker's own `timestamp` is. Luno's `timestamp` is the last order-book update, so on a thin pair it can lag by minutes while the quote is still live; the example allows 600 seconds.

The supported source is Luno's public ticker, for example `GET https://api.luno.com/api/1/ticker?pair=USDCZARU`:

```json
{"pair":"USDCZARU","timestamp":1793281695774,"bid":"16.688","ask":"16.6954","last_trade":"16.6972","rolling_24_hour_volume":"48048.05","status":"ACTIVE"}
```

`bid` and `ask` are quote per 1 base (ZARU per 1 USDC here), which is why the example declares `base_token: USDC`, `quote_token: ZARU`. The parser requires the `pair` to match, `status` to be `ACTIVE`, string prices, a numeric millisecond timestamp no more than 60 seconds ahead of the guard's clock, ask at or above bid, and a spread of at most `max_spread_bps` around the mid. A thin or broken book (bid 1, ask 100) has a mid that means nothing, and a response stamped in the future would never age out, so both are refused and the previous snapshot keeps ageing until it is stale.

The fetch does not follow redirects and reads at most 64 KiB.
