# Ordinary provider failure diagnostics

Ordinary `GenerationAttempt.errorSnapshot.providerDiagnostic` stores a selected,
redacted failure message independently of terminal, retry and billing evidence.
This changes future writes; it does not reconstruct messages already discarded by
older writers or change the separate video/template execution protocols.

## Contract

- `version: 1`, actual `attemptId`, `provider`, optional actual `providerTaskId`,
  bounded `message` (500 characters), `source`, and ISO `observedAt`.
- Authenticated task retrieval and callback diagnostics require a matching task
  ID. Submission and internal diagnostics may precede task assignment.
- Sources are `AUTHENTICATED_RETRIEVAL`, `AUTHENTICATED_SUBMISSION`,
  `CALLBACK_DIAGNOSTIC`, and `INTERNAL_DIAGNOSTIC`. Writers choose these from the
  call path. No source label is inferred from raw callback JSON.
- A late callback or internal diagnostic cannot overwrite existing authenticated
  retrieval text. Manual reconciliation and administrator resolution retain the
  validated original diagnostic without changing its source.
- The shared reader rechecks attempt/provider/task identity and sanitizes the
  message again. Raw response objects, signed URLs, credentials and storage object
  paths are not message fields. Provider adapters also redact their configured
  credentials before handing selected messages to Jobs.

Kie terminal observations remain in the separate
`responseSnapshot.providerTerminalEvidence` contract. Display diagnostics cannot
release a reservation, settle credits, retry, fail over, authorize an output or
turn a callback into authenticated terminal evidence. Failure classification uses
the original existing predicates; sanitization affects display text only.

## Local verification, 2026-11-14

- Config diagnostic tests: 27 passed.
- AI provider/HTTP/Kie/OpenRouter tests: 134 passed, using mocked HTTP responses.
- Jobs diagnostic/dispatch/reconciliation/callback/terminal-evidence tests:
  40 passed.
- Database administrator-operation unit tests: 15 passed.
- `runtime-stores.database.integration.test.ts`: 35 selected PostgreSQL cases
  passed in disposable loopback `ezpic_provider_diagnostics_test`; 83 unrelated
  cases skipped. Coverage includes rejection and uncertainty, callback provenance,
  authenticated retrieval, identity mismatch, administrator recovery, immutable
  charge policy, timeout settlement and reserved-credit retention.
- Config, AI, Database and Jobs type checks passed; affected file lint and format
  checks passed. Shared runtime formatting is handled by the integrating task.

No paid provider request or production write was made. These checks are local
evidence, not deployment or live-provider certification. No schema migration is
needed for the diagnostic JSON child.
