# One-time registered account login bonus

Every existing or new non-anonymous user can receive exactly one fixed grant of 5 credits. This is separate from the existing monthly free-plan grant, paid subscriptions, sessions and image-pass purchases. The bonus does not expire. No prices, moderation policies or generation charging rules change.

The session-created hook attempts the grant after login. Credit-balance reads and registered image generation preflight retry the same immutable command. A temporary bonus failure is logged without private error text and does not prevent login, balance reads or already-funded generation checks; the existing monthly-credit and generation checks still run. The database rechecks the actual user row, takes an advisory transaction lock on `login-bonus:user:<id>:v1`, and records the grant using the existing credit ledger, account locks and debt-repayment rules. A spent gift never becomes eligible again. Anonymous bootstrap users receive no gift. The gift does not unlock paid image models.

The upload-rate-limit action preserves the prompt/model settings through the existing sign-in draft flow; a local source image must be selected again after login. Exhausted guest allowance and unavailable guest eligibility show explicit account actions. The copy says one bonus per account and keeps monthly credits separate; content-safety rejection does not trigger a promotional action. Existing guest preview expiry disclosure remains accurate.

## Verification

- Database helper unit tests: 8 passed (simulated transaction serialization, not a real database race).
- API grant/replay wrapper tests: 9 passed, including transient-bonus-failure continuity for balance reads and generation.
- Guest workspace and landing feedback tests: 18 passed, including four actual locales and saving the guest draft before the sign-in action redirects.
- Auth package: 136 passed, including repeated verified sessions, session reads, magic links, anonymous bootstrap and grant-failure login recovery using real Better Auth handlers against its isolated memory adapter.
- PostgreSQL SQL-row-port suite: 5 passed using the actual gift, grant, reserve and settle functions, official installed SQL builders and disposable schemas. It verifies 24 concurrent gift claims, anonymous/missing/legacy identities, debt repayment, a spent gift across separate monthly grant identities, and immutable-command conflicts. No generated PrismaClient is constructed by this test port.
- Full generated-ORM PostgreSQL integration suite added: 24 concurrent gift claims, the actual independent monthly grant, anonymous and missing identities, and account/lot/ledger invariants. Local collection is blocked by the missing official Prisma generated client, so zero tests from that suite ran. The official engine download is unavailable through the environment gateway (CONNECT 403); no bypass or production database use. Normal CI must run this full integration gate before release.

No schema migration is required. No production grant, paid generation, merge or deployment has been performed by this branch. Repository-wide generated-client dependent type checks still require the normal CI environment.
