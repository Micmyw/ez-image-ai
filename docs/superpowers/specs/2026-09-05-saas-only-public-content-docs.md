# SaaS-Only Public Content and Docs Specification

## Objective

Make `apps/saas` the only public runtime application. Move the useful public content and
documentation capabilities from `apps/marketing` and `apps/docs` into same-origin SaaS routes,
then remove both standalone applications and their build/runtime wiring.

## Product boundary

- `/` remains the tool-first EzPic landing page and guest editing entry point.
- Public content lives at `/pricing`, `/privacy`, `/terms`, `/blog`, `/blog/[slug]`,
  `/changelog`, and `/contact`.
- Product documentation lives below `/docs`; documentation APIs and generated artifacts are also
  namespaced below `/docs` or `/docs/api`.
- Authenticated, administrative, checkout, and guest-workspace routes keep their current access and
  `noindex,nofollow` behavior.
- `apps/mail-preview` remains a development-only email utility. It is not a public product app and
  must not be started by the default root `dev`, `build`, or `start` commands.

## Public route and SEO contract

| Route                      | Content                                                             | Robots                     | Sitemap      |
| -------------------------- | ------------------------------------------------------------------- | -------------------------- | ------------ |
| `/`                        | Existing tool-first landing page                                    | `index,follow`             | Yes          |
| `/pricing`                 | Same configured plan and credit data as the landing pricing section | `index,follow`             | Yes          |
| `/privacy`                 | Existing EzPic privacy policy, without invented operator facts      | `index,follow`             | Yes          |
| `/terms`                   | Existing English EzPic terms, without placeholder translations      | `index,follow`             | Yes          |
| `/blog` and `/blog/[slug]` | Real EzPic articles only                                            | `noindex,follow` initially | No initially |
| `/changelog`               | Real EzPic product changes only                                     | `noindex,follow` initially | No initially |
| `/contact`                 | Configured support email using a `mailto:` link                     | `noindex,follow` initially | No initially |
| `/docs/**`                 | Real EzPic documentation                                            | `noindex,follow` initially | No initially |

Every public route owns an explicit same-origin canonical URL and exactly one visible `h1`.
The sitemap contains exactly `/`, `/pricing`, `/privacy`, and `/terms` until the remaining content
is approved for indexing. The landing footer visibly links Privacy, Terms, Blog, Changelog,
Contact, and Docs.

Permanent same-origin redirects preserve old public links:

- `/legal/privacy-policy` -> `/privacy`
- `/legal/terms` -> `/terms`
- `/de`, `/es`, `/fr` and their nested paths -> the equivalent unprefixed path

SaaS continues to choose the display language from its locale cookie. Do not add a generic root
`[locale]` segment because it conflicts with organization slugs.

## Content policy

- Do not migrate the starter Blog articles (`Favorite Things`, `Awesome second post`) or their
  fake authors/images.
- Replace them with at least one factual EzPic article based only on implemented product behavior.
- Do not migrate the hard-coded starter Changelog entries. Publish factual entries based on the
  current EzPic changelog and implementation.
- Do not migrate the current Contact form: it logs personal information and simulates success.
  Contact is a mail link to configured support email and fails closed when that value is absent.
- Keep real English legal copy and any non-placeholder translation. Missing or placeholder legal
  translations fall back to English; do not invent operator identity, jurisdiction, or legal facts.

## Documentation architecture

- Move Fumadocs source/content into SaaS and mount it at `/docs`.
- Use a nested docs layout; it must not render a second `<html>` or `<body>` and must reuse the SaaS
  theme provider.
- Set the Fumadocs source base URL to `/docs`.
- Namespace endpoints as `/docs/api/search`, `/docs/llms.txt`, `/docs/llms-full.txt`,
  `/docs/llms.mdx/**`, and `/docs/og/**`.
- Replace all `acme`, Lorem ipsum, `My App`, and missing-description output with factual EzPic
  content and metadata.
- Reserve the organization slug `docs` and the endpoint-owned docs slugs `api`, `og`, `llms.txt`,
  `llms-full.txt`, and `llms.mdx`.
- Generated Fumadocs output is recreated during install/generate/type-check and is never committed.
- The combined SaaS application must work with its default bundler and the supported Windows
  Webpack fallback; do not import the known-incompatible `fumadocs-mdx:collections/server` URI.

## Single-origin configuration

- `NEXT_PUBLIC_SAAS_URL` is the single canonical public origin.
- Retire `NEXT_PUBLIC_MARKETING_URL`, `NEXT_PUBLIC_DOCS_URL`, and `LOAD_MARKETING_BASE_URL` from
  active configuration and tests.
- CORS, guest draft origin validation, text moderation, production launch validation, and E2E
  fixtures must continue to fail closed against the single SaaS origin. Never replace the allowlist
  with `*`.
- Stable persisted identifiers such as `marketing_draft_created`, `marketing-draft`, advisory lock
  names, and historical analytics event names remain unchanged unless a data migration is designed.
- The load scenario named `marketing` may remain as a landing-page metric; it is not an application
  dependency.

## Repository retirement

- Delete `apps/marketing` and `apps/docs` only after their replacement routes and focused tests are
  green.
- Root `dev`, `build`, and `start` target only the `saas` workspace and its task dependencies.
- Remove obsolete lockfile importers, CI variables/artifacts, Playwright/Vitest invocations,
  originality-scanner roots, aliases, package references, and current documentation.
- Keep historical changelog entries and dated plans/specs as historical evidence; update only
  current guidance and the current Unreleased changelog section.
- No local commit, remote push, deployment, or live external Provider/payment call is authorized by
  this specification.

## Acceptance gates

1. New route tests are observed failing before production implementation and passing afterward.
2. SaaS unit tests cover public metadata, sitemap, redirects, content fallback, docs source URLs,
   search URLs, and reserved slugs.
3. Browser tests cover public routes, footer navigation, Docs root/nested/search/LLM routes, and
   private-route indexing protection.
4. `pnpm install --frozen-lockfile`, SaaS generation/type-check/build, root lint/format/tests/build,
   CI contract verification, and public-originality verification pass.
5. Static residue checks find no active `apps/marketing`, `apps/docs`, port `3001`, port `3002`,
   `NEXT_PUBLIC_MARKETING_URL`, or `NEXT_PUBLIC_DOCS_URL` references outside historical documents.
6. The worktree preserves unrelated user changes, contains no real credentials, and remains
   uncommitted/unpushed until the user explicitly requests publication.
