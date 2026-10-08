# Public page indexing

The owner approved indexing all public content and tool pages on 2026-10-08, while
retaining account, personal job, payment and private-state exclusions. This policy
supersedes the initial English-only and public-beta noindex rollout rules.

Create, Examples, Contact, Changelog, the Hotel Lobby beta landing page and the
public video guide now allow indexing and appear in the sitemap. Existing public
Home, image tools, models, legal pages, reviewed Blog and Docs retain indexing.
Public navigation already links the newly indexable routes. `/create?mode=video`
is public and canonicalizes to `/create`; robots.txt no longer disallows `/create`.

The main content of Home, Create, Examples, Image to Image, Pricing and Contact
already exists in English, German, Spanish and French. These explicit `?lang=`
views use self-canonical URLs, reciprocal hreflang including `x-default`, and
sitemap entries. Privacy has a real German document in addition to English.
Bare public URLs remain English regardless of account locale cookies.

English-only articles, model descriptions, Docs, Changelog, coloring guidance,
Hotel Lobby and Terms retain an English canonical and noindex for untranslated
language views. Spanish/French Privacy views also fall back to English. No new
translation is fabricated. Filtered Blog results and Raindance mode views retain
deduplication exclusions. Public tracking/preset and generator-mode parameters
alone do not make a page private.

Personal query keys (`asset`, `guestAsset`, `guestJob`, `job`, `videoJob`,
`reuseJob`, `parentJob`, `resume`, `draftError`, `upgrade`, `returnTo`) produce
`noindex, nofollow` in SSR metadata and HTTP headers, even for an empty value.
Their canonical removes personal state. Existing server-side authentication,
ownership checks, root private metadata and account locale handling are unchanged.
No robots directive substitutes for access control. Draft previews, draft
articles, authentication/account/payment pages, 404s and non-HTML Docs artifacts
retain their restrictions.

Hotel Lobby remains `beta`; making its landing page discoverable does not publish
the draft companion article, certify generation quality or create public samples.
Reviewed sample publication still requires the existing real-job, rights and
quality evidence. Draft, retired and invalid published records stay out of the
video landing-page sitemap collection.

Sitemap dates come from recorded editorial changes. Newly included pages without
maintained dates omit `lastmod`. Builds never advance these dates automatically.

Focused regression coverage checks HTTP/metadata agreement, translation
alternatives, personal queries, all sitemap targets, publication gates and public
navigation. Production validation must separately record the exact release SHA,
CI/deployment identities and unauthenticated initial HTML. Allowing indexing is
not evidence that a search engine has indexed or ranked a page.
