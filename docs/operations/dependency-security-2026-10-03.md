# Dependency security maintenance — 2026-10-03

Scope: PR #14 (`codex/effects-speed-release`). This repairs the dependency audit blocking that branch. It does not publish the website or jobs service.

## Audit result

The initial full `pnpm audit --json` reported 40 advisories: 1 critical, 10 high, 21 moderate and 8 low. After resolving the patched versions, the same full audit reports zero at every severity; `pnpm audit --prod --audit-level high` also exits successfully with no known vulnerabilities. These are registry advisory results at the time of validation.

The audit threshold, exclusions and CI gates are unchanged. `minimumReleaseAge: 1440` remains enabled; the selected fixed versions were verified in npm metadata to be more than 24 hours old. The security floor is recorded in the shared catalog and scoped dependency overrides, then resolved by pnpm into the lockfile. Consumer manifests retain `catalog:` references.

## Patched packages

| Package                                 | Previous affected version | Fixed version    |
| --------------------------------------- | ------------------------- | ---------------- |
| Next.js                                 | 16.3.4                    | 16.3.6           |
| Hono                                    | 4.13.3                    | 4.13.7           |
| Nodemailer                              | 9.1.1                     | 10.0.9           |
| Undici                                  | 7.29.0                    | 7.29.1           |
| Vitest and its mocker/coverage packages | 4.1.10                    | 4.1.11           |
| SimpleWebAuthn server                   | 13.3.1                    | 13.3.2           |
| body-parser                             | 2.2.1                     | 2.3.0            |
| brace-expansion                         | 2.1.4 / 5.0.9             | 2.1.7 / 5.0.12   |
| DOMPurify                               | 3.4.13                    | 3.4.16           |
| Engine.IO                               | 6.6.7                     | 6.6.10           |
| esbuild                                 | 0.18.20 / 0.27.7          | 0.25.12 / 0.28.1 |
| fast-uri                                | 3.1.7                     | 3.1.8            |
| js-yaml                                 | 4.3.1                     | 4.3.2            |
| qs                                      | 6.14.0                    | 6.16.0           |

Nodemailer requires the fixed 10.x line; the current API still uses `createTransport()` and `sendMail()`. A task-local loopback SMTP fixture verified authentication, recipient/cc/bcc handling, reply-to, text/HTML composition and omission of Bcc from delivered message headers. It sent no external email and closed its listener afterward. Normal TLS and production mail configuration were not changed.

## Verification and release boundaries

Validation uses the existing repository gates: `pnpm lint --deny-warnings`, `pnpm format:check`, `pnpm verify:ci-workflow`, `pnpm type-check`, `pnpm test:unit:contracts`, and `pnpm --filter saas build`. The PR's GitHub checks additionally exercise Linux/OpenNext packaging, disposable PostgreSQL and the mock media browser workflow. Consult the checks for the current commit before merging; local checks are not a production deployment.

All listed local gates passed on the updated dependencies, including all 22 type-check tasks. The frozen offline install also passed. The jobs Worker dry build and final-artifact workerd smoke passed with unauthorized requests rejected and executor routing verified; this smoke did not query PostgreSQL or a cloud service. The remote database and browser gates remain owned by the PR workflow.

The previous browser failure was a test synchronization issue: the subscription-upgrade test filled the prompt while `#registered-generator` was still `inert` and `data-editor-ready=false`. It now waits for readiness and verifies the entered value immediately. Existing draft-save/restore assertions and timeouts are preserved.

The combined release also exposed a homepage transfer-budget regression: CI measured 67,566 bytes of compressed HTML against the existing 64 KiB limit. Public pages were serializing the entire administration translation namespace. The root client provider now omits that namespace; the protected admin layout supplies it through a client provider that merges inherited application messages, including after client navigation. Server-side translations, page copy and the transfer-budget assertions stay unchanged.

The exact production homepage Playwright check was reproduced locally before the fix (67,502 gzip bytes) and passed afterward (63,164 gzip bytes). The root/provider checks passed for all four supported locales, and the SaaS type check passed. These local size measurements use the same test and production build mode; CI measurements can differ slightly with build paths and environment.

No migration, production environment change, real provider generation, or deployment is part of this patch. The original speed-batch rollout ordering still applies: compatible jobs receivers first, then the website producer, as described in [the first-image release notes](first-image-scanless-batch-2026-09-30.md).
