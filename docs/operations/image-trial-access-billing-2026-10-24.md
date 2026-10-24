# Image trial, subscription access and provider rejection billing

The owner selected these rules on 2026-10-24:

- A registered account receives one lifetime 10-credit sign-in allowance, enough for two
  Nano Banana 2 Lite 1K generations at 5 credits each. New recurring monthly Free grants stop.
- Free accounts may start Nano Banana 2 Lite 1K only. Other image products and their HD/quality
  options require an effective paid subscription, including new image-pass admissions. Existing
  paid-through and subscription grace rules remain authoritative. A purchased credit balance or
  pass alone does not establish a subscription.
- Supported, authenticated Kie sensitive-content rejections on new credit-funded quote snapshots
  charge the full original quote once even when the provider reports zero consumption/no output.

## Financial boundaries

The stable `login-bonus:user:<owner>:v1` identity is retained. A valid historical 5-credit sign-in
receipt or a new 10-credit receipt means the lifetime allowance has already been issued; it does
not grant a replacement or top-up. Existing monthly grants, purchased lots and subscription lots
retain their original balance, expiry and refund/debt protections. No historical balance is
clawed back. Concurrent login, account bootstrap and generation reuse that same receipt.

Current entitlement is checked in the API and the reservation transaction for new work and unused
quotes. Accepted job replay and provider recovery retain their frozen task identity and contracts.
Video and internal-template admission are independent and are not changed by these image rules.

New ordinary credit quote snapshots contain
`kiePolicyRejectionBillingPolicy=charge-quoted-credits-v1`. Settlement rechecks the original
supported rejection evidence, task/model identity, absence of another attempt/output/charge and
active reservation before charging with `settle:<job>`. It ends
`PROVIDER_POLICY_REJECTED_CHARGED`; `providerCharged=false` and provider cost zero remain true in
the attempt evidence. This charge neither claims nor spends the one-time output-review waiver.

Historical unmarked quote snapshots keep zero-charge settlement. Completed reservations are not
reopened. Technical failures, uncertain acceptance, ordinary returned-output moderation, independent
image passes and sponsored anonymous trials retain their established financial contracts. An
unsupported billing marker or conflicting attempt evidence holds the original reservation.

## Release order

1. Deploy compatible Jobs consumers, including both Serializable and fresh-read settlement paths,
   before website producers freeze the new charge marker. Keep old-snapshot consumers while
   historical accepted work drains. Disabling producers does not erase already accepted policies.
2. Deploy the matching API/database admission checks, account grant producers and website copy.
   No new environment variables or schema migration are needed. Do not regrant existing receipts.
3. Verify the exact CI/deployment versions and account-scoped live views separately. A local test
   or prepared artifact does not certify production behavior and does not authorize paid generation.

## Local acceptance

Use disposable PostgreSQL with all current migrations and UTC sessions. Check both credit settlement
isolation branches, duplicate reconciliation/settlement, administrator recovery, evidence conflicts,
historical zero-charge preservation, unchanged grace and account ownership. Check premium admission
and unused quotes after subscription expiry, paid-through/grace access and accepted replay. Login
grant tests must cover concurrent first claims, historical 5-credit receipts, replay after spending,
debt/refund/admin races and absence of new monthly grants. Render charge/upgrade messages in more
than one locale and check locale key/interpolation parity.
