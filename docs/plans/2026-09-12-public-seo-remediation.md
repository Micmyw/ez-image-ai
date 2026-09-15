# Public SEO remediation

Scope: address the 2026-09-12 live SEO audit in the current checkout. Preserve existing dirty work, private media ownership, generation gates, billing, and organization routes. No deployment or paid generation is included in the local implementation.

## Functional work

1. **Truthful homepage and support content.** Align unavailable editing states and CTA labels, provide useful next steps, clarify instructions and illustrative examples, and fill legal/contact facts only from verified operator input.
2. **Public discovery and language consistency.** Open independently useful guides for indexing, align sitemap and robots, replace ineligible search markup with factual site identity, and stabilize public language without disturbing account localization.
3. **HTTP and public route behavior.** Upgrade safe HTTP navigation to the canonical HTTPS origin, preserve hostile-host rejection and write-request behavior, and return a public 404 before account authentication for unknown routes.
4. **Mobile experience and verification.** Prevent the consent banner from covering the primary action; verify focused regression tests, browser contracts, affected type checks, formatting/linting, and appropriate cross-workspace gates.

## Evidence and unresolved inputs

- Current production generation and guest switches are disabled. The UI must accurately reflect that state; changing presentation must not enable a service or bypass server capability checks.
- The user confirmed `support@ezimageai.com` for support and `noreply@ezimageai.com` for outbound email, and that an individual operates the service. Public support configuration is populated; legal pages describe individual operation without publishing a personal name or inventing a company, location, or jurisdiction. Mailbox receipt has not been tested.
- Public language scope was requested. In the absence of a different preference, implementation uses stable English public SEO with account language preferences preserved; no translated URL migration or hreflang cluster is introduced.
- Real product output case studies require verified, publishable input/output evidence. Illustrations must remain identified as illustrations.
- Keep local implementation, automated tests, deployed HTTP behavior, and Google processing as separate completion states.

## Approved public discovery policy

- Index `/`, `/pricing`, `/privacy`, `/terms`, `/blog`, the two published Blog articles, and the five reviewed Docs topics. Docs indexing is an explicit frontmatter opt-in. Keep Contact, Changelog, Docs API, Markdown and image artifacts out of indexing.
- Sitemap membership follows published Blog content and indexable Docs. Omit lastmod until genuine page-revision dates can be maintained.
- Keep normal visible FAQs; use factual WebSite identity instead of ineligible application/FAQ rich-result markup. Google removed FAQ rich results on 2026-05-07 and their documentation on 2026-06-15, verified during the audit at `https://developers.google.com/search/updates#removing-faq-rich-result`.
- Unmatched multi-segment routes and missing public articles/topics return 404. A single segment is a defined organization route, so an anonymous request there still redirects to login; it is not evidence of an unmatched-route defect. This corrects the scope of audit finding F5.
- Public prose uses real same-origin links and avoids presenting implementation internals as editing instructions. Examples remain explicitly illustrative; no generated output or testimonial is fabricated.

## Verification notes

- Canonical-host HTTP GET/HEAD regression: RED (2 failures, 13 passes) then GREEN (15 passes).
- SEO metadata/sitemap/schema regressions: RED (7 failures, 17 passes) then included in 39 passing focused SaaS tests.
- Markdown navigation regression: RED (plain text instead of anchors) then GREEN in the same focused suite.
- Browser RED reproduced unmatched-path 307, cookie-driven public German HTML, an unavailable free-trial CTA, and CTA obstruction at 390px/320px.
- Do not run SaaS Vitest concurrently with Next: both regenerate `.source` for different bundlers. A concurrent verification attempt was discarded after the Vite output reached the webpack dev server.

## Final local verification — 2026-09-12

- SaaS package unit tests: **78 files, 373 tests passed**. Web-host package unit tests: **3 files, 28 tests passed**. These are affected-package results, not a full-workspace test certification.
- Browser verification covers **46 unique tests** across public SEO, public routes, Docs and the landing editor. The full run passed 44; a focused rerun passed the remaining 2 after normalizing equivalent root canonical URLs and allowing for observed cold route compilation. No product behavior was changed to satisfy those two test corrections.
- The initial-HTML test fetched all **12 sitemap targets** with a German locale cookie and without executing JavaScript. Each returned 200, English HTML, one H1, a nonempty description, a self canonical, `index, follow`, and no noindex response header. It also confirmed factual WebSite markup and the homepage prompt-guide link.
- Unknown multi-segment paths and missing Blog/Docs content returned HTTP 404 with no login redirect. The rendered public 404 provided a home link. Anonymous `/create`, `/history` and organization-slug routes continued to redirect to login.
- Public-to-login navigation preserved the account's German locale cookie while public pages stayed English. Capability retry retained the prompt without submitting an edit. At 320px and 390px the primary action remained unobscured and consent choice persisted after reload.
- SaaS, web-host and i18n type checks passed. The earlier SaaS type failure in concurrently edited storage code cleared on the final normal SaaS type-check run; no unrelated storage code was changed for this task.
- Formatting and linting were checked on the affected SEO files; the final browser test edits received a separate focused check.
- Evidence, the 12-URL HTML inventory, browser logs and mobile screenshots are saved under the task's `seo-audit` artifact directory.

## Delivery boundary — 2026-09-12

Changes remain local and uncommitted. No push, deployment, production packaging, or real paid generation was performed. The current generation gates remain disabled. Live mail receipt, independent-network www/TLS behavior, deployment validation, Search Console indexing and field Core Web Vitals are **NOT_COMPLETED**. The support address is operator-confirmed; legal copy does not constitute verification of jurisdiction-specific obligations.

## Homepage keyword restoration — 2026-09-16

The user reconfirmed the original keyword contract after later iterations changed the homepage to
"AI Image Generator & Editor". The homepage again targets `ai image editor no restrictions`, uses
`ai image editor with prompt no restrictions` in an explanatory FAQ, and naturally includes
`ai image editor with prompt` in the description. Title, H1, first-view copy and the closing action
share the prompt-editing focus. Social metadata and WebSite description follow the same metadata.

The hero contains the keyword H1 and one short instruction: "Upload an image and describe the change
you want." The explanatory FAQ defines "No Restrictions" as flexible prompt editing beyond fixed
templates; content safety, legal, model and usage limits continue to apply. Existing how-to steps
and FAQs are preserved, as requested; one explanatory FAQ is added. Text-to-image, reference editing,
models, pricing, authentication and generation gates are unchanged. Public URLs remain English.

The hero regression now reads real translations instead of a hardcoded obsolete title. Before the
copy repair, the affected checks failed on the actual Generator title and H1 (2 failed, 21 passed).
The existing homepage browser check verifies initial HTML, the expandable FAQ explanation and the
concise hero at desktop and mobile widths. The user authorized pushing and deploying the completed
refinement; deployment and live verification remain separate from local checks and search rankings.

Final verification: 23 affected unit tests passed; the focused homepage browser case passed with
initial-HTML checks and inspected 1440px/390px screenshots. SaaS and i18n type checks, affected-file
formatting and lint passed. All four locale bundles preserve the previous instructions and FAQs,
add the same explanatory FAQ, and retain compatible accent markup; English and German messages
also rendered through the real translation formatter. The temporary browser server exited.
