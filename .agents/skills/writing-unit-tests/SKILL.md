---
name: writing-unit-tests
description: Use when adding Vitest coverage for TypeScript business logic, oRPC procedures, or app-local helpers.
---

# Write unit tests

## Scope

Use for deterministic logic and server handlers that can be exercised without a browser. Do not duplicate a user journey better covered by Playwright or test generated Prisma output.

## Procedure

1. Co-locate a `*.test.ts` or `*.test.tsx` file with the implementation. Existing suites run in `packages/api`, `apps/saas`, and `apps/marketing`.
2. Follow the nearest `vitest.config.ts`; SaaS aliases such as `@auth` and `@organizations` are configured there, while API tests use package imports.
3. Mock external boundaries with `vi.mock` before importing mocked bindings and the subject. Reset mocks in `beforeEach` when return values or call counts can leak. Keep validation, authorization, success, and failure cases explicit.
4. For protected oRPC procedures, mock Better Auth plus database/provider boundaries, then call the procedure with the real oRPC context shape shown below. The middleware builds `context.user`/`context.session` from `auth.api.getSession`; do not inject a fake user directly into the base context. For failures, use `await expect(call(...)).rejects.toMatchObject({ code: "FORBIDDEN" })`. Import `ORPCError` from `@orpc/server` only when asserting the error class.

### Protected procedure example

```ts
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/database", () => ({
	getOrganizationById: vi.fn(),
}));

import { call } from "@orpc/server";
import { auth } from "@repo/auth";
import { getOrganizationById } from "@repo/database";

vi.mocked(auth.api.getSession).mockResolvedValue(authenticatedSession);
vi.mocked(getOrganizationById).mockResolvedValue(organization);

const result = await call(procedure, input, {
	context: { headers: new Headers() },
});
```

5. Run the owning workspace:
   ```bash
   pnpm --filter @repo/api test
   pnpm --filter saas test
   pnpm --filter marketing test
   ```
   The exact PR unit command is:
   ```bash
   pnpm --filter @repo/api --filter saas --filter marketing test
   ```
6. Run `pnpm format`, `pnpm lint`, and `pnpm type-check`.

## Canonical reference

`packages/api/modules/payments/procedures/create-checkout-link.test.ts` shows protected-session, database, provider, and membership mocks plus `call(...)`. `packages/api/orpc/procedures.test.ts` proves how auth middleware enriches context and asserts `UNAUTHORIZED`/`FORBIDDEN`. `packages/api/modules/organizations/procedures/generate-organization-slug.test.ts` is the simpler public-procedure pattern.

## Done

The test controls auth and external boundaries, exercises the real procedure/middleware call path, demonstrates the regression or contract, passes in its owning workspace, and passes the exact repository unit command.

## Common mistakes

- Importing the subject before declaring a hoisted dependency mock.
- Passing `{ user }` as the base context and bypassing protected-procedure session middleware.
- Mocking `@repo/database` without every export loaded by the subject.
- Testing implementation details instead of inputs, outputs, and side effects.
- Using the filter `api`; the package name is `@repo/api`.
- Adding snapshots for dynamic IDs, dates, or generated markup without normalization.
