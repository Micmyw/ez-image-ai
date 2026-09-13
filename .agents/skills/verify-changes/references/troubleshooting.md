# Verification troubleshooting

Use only for a matching failure. Scope formatter fixes to intended files and review their diff.

| Failure                                                   | Cause                                                                                       | Fix                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Missing `packages/database/prisma/generated/client`       | Clean checkout or changed Prisma schema has not generated the ignored client                | Run `pnpm --filter @repo/database generate`; never edit generated client/Zod output  |
| `ERR_PNPM_NO_MATCHING_VERSION` or catalog install refusal | A catalog entry is wrong or the release is younger than `minimumReleaseAge: 1440`           | Correct/reuse `catalog:` or choose an eligible release; do not disable the age guard |
| `pnpm format:check` reports Markdown/TS indentation       | Hand indentation differs from Oxfmt output, including tabs in formatted TypeScript examples | Run `pnpm format`, review the diff, then rerun `pnpm format:check`                   |
| No root `e2e` script or wrong filter                      | E2E is app-local; CI unit uses exact workspace names                                        | Use the commands above, including `@repo/api` and `@repo/database`                   |
